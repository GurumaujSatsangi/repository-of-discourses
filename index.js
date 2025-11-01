import express from "express";
import session from "express-session";
import dotenv from "dotenv";
import { createClient } from '@supabase/supabase-js';


const app=express();

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

app.get("/", async (req,res)=>{
return res.render("add.ejs",{message:null});
});

app.post("/add", async(req,res)=>{
const {title,text_link,audio_link,date} = req.body;

const {data,error} = await supabase.from("content").insert(
    {title:title,text_link:text_link,audio_link:audio_link,date:date}
);

if(error){
    return res.render("/?message=There was some error adding the content.");
}
else{
return res.render("/?message=Content Added Succesfully!");
}
});

app.listen(3000,(req,res)=>{
    console.log("Running on port 3000!");
})
