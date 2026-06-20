import express from "express";
import session from "express-session";
import dotenv from "dotenv";
import { v4 as uuidv4 } from 'uuid';
import { QdrantClient } from '@qdrant/js-client-rest';
import { pipeline } from '@xenova/transformers';
import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from "url";
import path from "path";

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static("public"));
app.set("view engine", "ejs");
app.use("/static", express.static(path.join(__dirname, "public")));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());

dotenv.config();

// --- Qdrant & AI Setup (Left Intact) ---
let extractor;

async function getExtractor() {
    if (!extractor) {
        extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    }
    return extractor;
}

async function generateVector(text) {
    const extract = await getExtractor();
    const output = await extract(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
}

const client = new QdrantClient({ url: process.env.QDRANT_ENDPOINT, apiKey: process.env.QDRANT_API_KEY });

async function setupDatabase() {
    await client.createCollection('repository_semantic_texts', {
        vectors: {
            size: 384,
            distance: 'Cosine',
        },
    });
    console.log("Collection created!");
}
app.post("/generate-vector/:id", checkAuth, async (req, res) => {
    const item_id = req.params.id;

    try {
        // 1. Fetch text data from Supabase using .single() to get an object instead of an array
        const { data, error } = await supabase
            .from("content")
            .select("text")
            .eq("id", item_id)
            .single();

        if (error || !data || !data.text) {
            return res.redirect("/add?message=Error: Text content not found for vector generation.");
        }

        console.log("Generating vector for text:", data.text);

        // 2. Generate the 384-dimensional vector embedding via Xenova
        const resultVector = await generateVector(data.text);

        // 3. Upsert the generated vector into Qdrant Cloud
        await client.upsert('repository_semantic_texts', {
            wait: true,
            points: [
                {
                    id: item_id, // Match the exact ID from your relational database
                    vector: resultVector,
                    payload: {
                        text: data.text,
                        supabase_id: item_id
                    }
                }
            ]
        });

        // 4. Update vector status flag back in your Supabase table
        const { error: updateError } = await supabase
            .from("content")
            .update({ "vector_status": "GENERATED" })
            .eq("id", item_id);

        if (updateError) {
            console.error("Supabase status update failed:", updateError);
        }

        // 5. Always redirect or respond to prevent the request from hanging
        return res.redirect("/add?message=Vector generated and synced to Qdrant successfully!");

    } catch (err) {
        console.error("Unhandled error in vector generation route:", err);
        return res.redirect(`/add?message=Error processing vector generation: ${err.message}`);
    }
});


app.post("/generate-vector",checkAuth,async(req,res)=>{

    const {query} = req.body;
    const queryVector = await generateVector(query);

    const searchResults = await client.search('repository_semantic_texts', {
    vector: queryVector,
    limit: 5,
    with_payload: true,
    });
    console.log(searchResults);


    res.render("output.ejs",{searchResults});

})



// --- Supabase Setup ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
  auth: {
    flowType: 'pkce', // This forces Supabase to return a '?code=' instead of an '#access_token='
  },
});
// --- Auth Middleware ---
async function checkAuth(req, res, next) {
    // 1. Get the access token set by the callback
    const accessToken = req.cookies['sb-access-token'];

    if (!accessToken) {
        return res.redirect("/?message=Session Expired, Login using your credentials!");
    }

    try {
        // 2. Validate the token directly with Supabase
        const { data, error } = await supabase.auth.getUser(accessToken);

        if (error || !data.user) {
            return res.redirect("/?message=Session Expired, Login using your credentials!");
        }

        // 3. Attach the Supabase user object to the request
        req.user = data.user;
        next();
    } catch (err) {
        return res.redirect("/?message=Session Expired, Login using your credentials!");
    }
}

// --- Routes ---

app.post("/user-login", async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ error: 'Email address is required.' });
    }

    const { data, error } = await supabase.auth.signInWithOtp({
        email,
        options: {
            // Point this directly to your Node server callback endpoint
            emailRedirectTo: 'http://localhost:3000/auth/callback',
        },
    });

    if (error) {
        return res.redirect("/?message="+error.message);
    }

    return res.redirect("/?message=Sign In Link has been sent to your Email ID! Check for an Email with the subject - Your sign-in link.");
});

app.get('/auth/callback', async (req, res) => {
    const code = req.query.code;

    if (!code) {
        return res.status(400).send('Authentication code is missing from url.');
    }

    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
        return res.status(400).send(`Authentication failed: ${error.message}`);
    }

    const { access_token, refresh_token } = data.session;

    res.cookie('sb-access-token', access_token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 3600 * 1000 });
    res.cookie('sb-refresh-token', refresh_token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 30 * 24 * 3600 * 1000 });

    return res.redirect('/add');
});

app.get("/logout", async (req, res) => {
    // Optionally tell Supabase to invalidate the session on their end
    const accessToken = req.cookies['sb-access-token'];
    if (accessToken) {
        await supabase.auth.admin.signOut(accessToken).catch(() => {});
    }

    // Clear the specific Supabase cookies we set
    res.clearCookie("sb-access-token", { httpOnly: true });
    res.clearCookie("sb-refresh-token", { httpOnly: true });

    return res.redirect("/?message=Logged out successfully");
});

app.get("/", async (req, res) => {
    const { message, search, filter_date } = req.query;
    let query = supabase.from("content").select("*");

    if (search && search.trim() !== "") {
        query = query.or(`title.ilike.%${search}%,text_link.ilike.%${search}%,audio_link.ilike.%${search}%`);
    }

    if (filter_date && filter_date.trim() !== "") {
        query = query.eq("date", filter_date);
    }

    const { data, error } = await query;
    return res.render("home.ejs", { message: message || null, content: data, search: search || "", filter_date: filter_date || "" });
});

app.get("/add", checkAuth, async (req, res) => {
    const { message, search, filter_date } = req.query;
    let query = supabase.from("content").select("*");

    if (search && search.trim() !== "") {
        query = query.or(`title.ilike.%${search}%,text_link.ilike.%${search}%,audio_link.ilike.%${search}%`);
    }

    if (filter_date && filter_date.trim() !== "") {
        query = query.eq("date", filter_date);
    }

    const { data, error } = await query;
    return res.render("add.ejs", { message: message || null, user: req.user, content: data, search: search || "", filter_date: filter_date || "" });
});

app.get("/delete/:id", checkAuth, async (req, res) => {
    const { data, error } = await supabase.from("content").delete().eq("id", req.params.id);
    return res.redirect("/?message=Content Deleted Succesfully!");
});

app.get("/edit/:id", checkAuth, async (req, res) => {
    const message = req.query.message;
    const { data, error } = await supabase.from("content").select("*").eq("id", req.params.id).single();
    return res.render("edit.ejs", { message: message || null, content: data });
});

app.post("/edit", checkAuth, async (req, res) => {
    const { id, title, text_link, audio_link, date } = req.body;
    const { data, error } = await supabase.from("content").update({
        title,
        text_link,
        audio_link,
        date
    }).eq("id", id);

    if (error) {
        return res.redirect("/?message=There was some error updating the content!");
    } else {
        return res.redirect("/?message=Content updated succesfully!");
    }
});

app.post("/add", checkAuth, async (req, res) => {
    const { title, text_link, audio_link, date } = req.body;

    const { data, error } = await supabase.from("content").insert(
        { title: title, text_link: text_link, audio_link: audio_link, date: date }
    );

    if (error) {
        return res.redirect("/?message=There was some error adding the content.");
    } else {
        return res.redirect("/?message=Content Added Succesfully!");
    }
});

app.listen(3000, () => {
    console.log("Running on port 3000!");
});