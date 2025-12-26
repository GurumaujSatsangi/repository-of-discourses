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
    const {message, search, filter_date}=req.query;
    let query = supabase.from("content").select("*");
    
    if(search && search.trim() !== "") {
        query = query.or(`title.ilike.%${search}%,text_link.ilike.%${search}%,audio_link.ilike.%${search}%`);
    }
    
    if(filter_date && filter_date.trim() !== "") {
        query = query.eq("date", filter_date);
    }
    
    const {data, error}= await query;
    return res.render("add.ejs",{message: message || null, content: data, search: search || "", filter_date: filter_date || ""});
});

app.get("/delete/:id",async(req,res)=>{
    const {data,error}=await supabase.from("content").delete().eq("id",req.params.id);
    return res.redirect("/?message=Content Deleted Succesfully!")
})

app.get("/edit/:id",async(req,res)=>{
    const message=req.query.message;
    const {data,error}=await supabase.from("content").select("*").eq("id",req.params.id).single();
    return res.render("edit.ejs",{message: message||null, content:data});
})

app.post("/edit",async(req,res)=>{
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
