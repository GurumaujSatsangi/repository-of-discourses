import express from "express";
import session from "express-session";
import dotenv from "dotenv";
import { v4 as uuidv4 } from 'uuid'; // npm i uuid
import { QdrantClient } from '@qdrant/js-client-rest';
import { pipeline } from '@xenova/transformers';
import bcrypt from 'bcrypt';
import bodyParser from "body-parser";
import jwt from 'jsonwebtoken';
import cookieParser from "cookie-parser";
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from "url";
import path from "path";




const app=express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static("public"));
app.set("view engine", "ejs");
app.use("/static", express.static(path.join(__dirname, "public")));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());
app.set("view engine", "ejs");


dotenv.config();

let extractor;

async function getExtractor() {
    if (!extractor) {
        // Loads the model locally the first time it runs
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
    // Create a collection configured for our specific model
    await client.createCollection('repository_semantic_texts', {
        vectors: {
            size: 384, // The dimension size for all-MiniLM-L6-v2
            distance: 'Cosine',
        },
    });
    console.log("Collection created!");
}


const text = "Hi, My name is Gurumauj Satsangi. I am from Kolkata."
const author = "Gurumauj"

// const vector = await generateVector(text);
    
//     // 2. Store in Qdrant with a unique ID and the original text as payload
//     await client.upsert('repository_semantic_texts', {
//         wait: true,
//         points: [
//             {
//                 id: uuidv4(),
//                 vector: vector,
//                 payload: { text: text, author: author }
//             }
//         ]
//     });


    const queryText = "Gurumauj from Kolkata"

const queryVector = await generateVector(queryText);
    
    // 2. Search Qdrant for the closest matches
    const searchResults = await client.search('repository_semantic_texts', {
        vector: queryVector,
        limit: 5, // Top 5 results
        with_payload: true, // Return the original text, not just the ID
    });

    console.log(searchResults);

// setupDatabase()



const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

app.post("/user-login", async (req, res) => {
  try {
    const { email, password } = req.body;

    // fetch user
    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .single();

    if (error || !user) {
      return res.redirect("/?message=No such user exists!");
    }

    // compare password (plain, hashed)
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.redirect("/?message=Invalid Login Credentials!");
    }

    // generate jwt
    const token = jwt.sign(
      { email: user.email, id: user.id },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    // set cookie
    res.cookie("token", token, {
      httpOnly: true,
      secure: false, // true in production (HTTPS)
      sameSite: "strict",
      maxAge: 15 * 60 * 1000 // 15 minutes
    });

    return res.redirect("/add?message=Welcome!");

  } catch (err) {
    console.error(err);
    return res.status(500).send("Server Error");
  }
});


app.get("/add", checkAuth, async (req,res)=>{
    const {message, search, filter_date}=req.query;
    let query = supabase.from("content").select("*");
    
    if(search && search.trim() !== "") {
        query = query.or(`title.ilike.%${search}%,text_link.ilike.%${search}%,audio_link.ilike.%${search}%`);
    }
    
    if(filter_date && filter_date.trim() !== "") {
        query = query.eq("date", filter_date);
    }
    
    const {data, error}= await query;
    return res.render("add.ejs",{message: message || null, user:req.user,  content: data, search: search || "", filter_date: filter_date || ""});
});

app.get("/logout", (req, res) => {
  res.clearCookie("token", {
    httpOnly: true,
    sameSite: "strict",
    secure: false // true in production
  });

  return res.redirect("/?message=Logged out successfully");
});

app.get("/", async (req,res)=>{
    const {message, search, filter_date}=req.query;
    let query = supabase.from("content").select("*");
    
    if(search && search.trim() !== "") {
        query = query.or(`title.ilike.%${search}%,text_link.ilike.%${search}%,audio_link.ilike.%${search}%`);
    }
    
    if(filter_date && filter_date.trim() !== "") {
        query = query.eq("date", filter_date);
    }
    
    const {data, error}= await query;
    return res.render("home.ejs",{message: message || null,  content: data, search: search || "", filter_date: filter_date || ""});
});

app.get("/delete/:id",checkAuth, async(req,res)=>{
    const {data,error}=await supabase.from("content").delete().eq("id",req.params.id);
    return res.redirect("/?message=Content Deleted Succesfully!")
})

app.get("/edit/:id",checkAuth, async(req,res)=>{
    const message=req.query.message;
    const {data,error}=await supabase.from("content").select("*").eq("id",req.params.id).single();
    return res.render("edit.ejs",{message: message||null, content:data});
})

app.post("/edit", checkAuth, async(req,res)=>{
    const {id,title,text_link,audio_link,date}=req.body;
    const{data,error}=await supabase.from("content").update({
        title,
        text_link,
        audio_link,
        date
    }).eq("id",id);

    if(error){
        return res.redirect("/?message=There was some error updating the content!")
    }
    else{
        return res.redirect("/?message=Content updated succesfully!");
    }
})

app.post("/add", checkAuth, async(req,res)=>{
const {title,text_link,audio_link,date} = req.body;

const {data,error} = await supabase.from("content").insert(
    {title:title,text_link:text_link,audio_link:audio_link,date:date}
);

if(error){
    return res.redirect("/?message=There was some error adding the content.");
}
else{
return res.redirect("/?message=Content Added Succesfully!");
}
});

app.listen(3000,(req,res)=>{
    console.log("Running on port 3000!");
})


async function checkAuth(req, res, next) {
  const token = req.cookies.token;

  if (!token) {
    return res.redirect("/?message=Session Expired, Login using your credentials!");
  }

  try {
    // decode JWT
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // fetch user using email from token
    const {data,error} = await supabase.from("users").select("*").eq("email",decoded.email).single();

    if (!data || error) {
      return res.redirect("/?message=Some Error Occured, Please try again later.");
    }

    // attach user to request
    req.user = data;

    // move to next route handler
    next();
  } catch (err) {
    return res.redirect("/?message=Session Expired, Login using your credentials!");
  }
}
