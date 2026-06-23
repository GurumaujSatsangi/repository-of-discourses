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

dotenv.config();

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static("public"));
app.set("view engine", "ejs");
app.use("/static", express.static(path.join(__dirname, "public")));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());

// --- Supabase Setup ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: {
        flowType: 'pkce',
    },
});

// --- Qdrant & AI Setup ---
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

// --- NER Token Aggregator Helper ---
function formatAndGroupEntities(rawTokens) {
    const groupedEntities = [];
    let currentEntity = null;

    for (const token of rawTokens) {
        const isSubword = token.word.startsWith('##');
        const cleanWord = token.word.replace(/^##/, '');
        const entityCategory = token.entity.replace(/^[BI]-/, '');

        if (token.entity.startsWith('B-')) {
            if (currentEntity) {
                groupedEntities.push(currentEntity);
            }
            currentEntity = {
                word: cleanWord,
                entity: entityCategory,
                score: token.score
            };
        } else if (token.entity.startsWith('I-') && currentEntity && currentEntity.entity === entityCategory) {
            if (isSubword) {
                currentEntity.word += cleanWord;
            } else {
                currentEntity.word += ' ' + cleanWord;
            }
            // Retain the average score or lowest confidence score for safety
            if (token.score < currentEntity.score) {
                currentEntity.score = token.score;
            }
        }
    }
    if (currentEntity) {
        groupedEntities.push(currentEntity);
    }
    return groupedEntities;
}

async function extractEntities(longText) {
    if (!longText) return [];
    
    const classifier = await pipeline('token-classification', 'Xenova/bert-base-NER');

    // Split paragraphs into individual sentences to safe-guard against the 512 token limit
    const sentences = longText.match(/[^.!?]+[.!?]+/g) || [longText];
    const rawEntities = [];

    for (const sentence of sentences) {
        const tokens = await classifier(sentence.trim());
        rawEntities.push(...tokens);
    }

    // Process the messy tokens into human-readable words
    return formatAndGroupEntities(rawEntities);
}

// --- Auth Middleware ---
async function checkAuth(req, res, next) {
    const accessToken = req.cookies['sb-access-token'];

    if (!accessToken) {
        return res.redirect("/?message=Session Expired, Login using your credentials!");
    }

    try {
        const { data, error } = await supabase.auth.getUser(accessToken);
        if (error || !data.user) {
            return res.redirect("/?message=Session Expired, Login using your credentials!");
        }
        req.user = data.user;
        next();
    } catch (err) {
        return res.redirect("/?message=Session Expired, Login using your credentials!");
    }
}

// --- Routes ---

app.get("/view/:itemid", checkAuth, async (req, res) => {
    const item_id = req.params.itemid;
    try {
        const { data, error } = await supabase.from("content").select("*").eq("id", item_id).single();

        if (error || !data) {
            return res.redirect("/add?message=Content not found.");
        }

        const result = await extractEntities(data.text);
        return res.render("view.ejs", { data, result });
    } catch (err) {
        console.error("Error in view route:", err);
        return res.redirect("/add?message=Error processing NER parsing.");
    }
});

app.post("/generate-vector/:id", checkAuth, async (req, res) => {
    const item_id = req.params.id;

    try {
        const { data, error } = await supabase
            .from("content")
            .select("text")
            .eq("id", item_id)
            .single();

        if (error || !data || !data.text) {
            return res.redirect("/add?message=Error: Text content not found for vector generation.");
        }

        console.log("Generating vector for text:", data.text);
        const resultVector = await generateVector(data.text);

        await client.upsert('repository_semantic_texts', {
            wait: true,
            points: [
                {
                    id: item_id,
                    vector: resultVector,
                    payload: {
                        text: data.text,
                        supabase_id: item_id
                    }
                }
            ]
        });

        const { error: updateError } = await supabase
            .from("content")
            .update({ "vector_status": "GENERATED" })
            .eq("id", item_id);

        if (updateError) {
            console.error("Supabase status update failed:", updateError);
        }

        return res.redirect("/add?message=Vector generated and synced to Qdrant successfully!");

    } catch (err) {
        console.error("Unhandled error in vector generation route:", err);
        return res.redirect(`/add?message=Error processing vector generation: ${err.message}`);
    }
});

app.post("/generate-vector", checkAuth, async (req, res) => {
    const { query } = req.body;
    const queryVector = await generateVector(query);

    const searchResults = await client.search('repository_semantic_texts', {
        vector: queryVector,
        limit: 5,
        with_payload: true,
    });

    res.render("output.ejs", { searchResults, query });
});

app.post("/user-login", async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ error: 'Email address is required.' });
    }

    const { data, error } = await supabase.auth.signInWithOtp({
        email,
        options: {
            emailRedirectTo: 'http://localhost:3000/auth/callback',
        },
    });

    if (error) {
        return res.redirect("/?message=" + error.message);
    }

    return res.redirect("/?message=Sign In Link has been sent to your Email ID!");
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
    const accessToken = req.cookies['sb-access-token'];
    if (accessToken) {
        await supabase.auth.admin.signOut(accessToken).catch(() => {});
    }

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
    await supabase.from("content").delete().eq("id", req.params.id);
    return res.redirect("/?message=Content Deleted Succesfully!");
});

app.get("/edit/:id", checkAuth, async (req, res) => {
    const message = req.query.message;
    const { data, error } = await supabase.from("content").select("*").eq("id", req.params.id).single();
    return res.render("edit.ejs", { message: message || null, content: data });
});

app.post("/edit", checkAuth, async (req, res) => {
    const { id, title, text_link, audio_link, date } = req.body;
    const { error } = await supabase.from("content").update({ title, text_link, audio_link, date }).eq("id", id);

    if (error) {
        return res.redirect("/?message=There was some error updating the content!");
    } else {
        return res.redirect("/?message=Content updated succesfully!");
    }
});

app.post("/add", checkAuth, async (req, res) => {
    const { title, text_link, audio_link, date } = req.body;
    const { error } = await supabase.from("content").insert({ title, text_link, audio_link, date });

    if (error) {
        return res.redirect("/?message=There was some error adding the content.");
    } else {
        return res.redirect("/?message=Content Added Succesfully!");
    }
});

app.listen(3000, () => {
    console.log("Running on port 3000!");
});