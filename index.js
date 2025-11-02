import express from "express";
import session from "express-session";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import { createClient } from '@supabase/supabase-js';


const app=express();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.set("view engine", "ejs");


dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

app.get("/", async (req,res)=>{
    const {message}=req.query;
    const {data, error}=await supabase.from("content").select("*");
return res.render("add.ejs",{message: message || null, content: data});
});

app.post("/add", async(req,res)=>{
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
