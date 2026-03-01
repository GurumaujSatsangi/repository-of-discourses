import express from "express";
import session from "express-session";
import dotenv from "dotenv";
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
