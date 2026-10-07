#!/usr/bin/env python3
"""Builds public/index.html from the artifact page (../shrishti.html) by wrapping it
in a full document and pointing it at the project's own server. Kept for reference;
public/index.html is already built."""
import re,sys
src=open(sys.argv[1],encoding='utf-8').read()
def rep(a,b):
    global src
    assert a in src,'MISSING '+a[:80]
    src=src.replace(a,b,1)
# 1. share links are built from this site's own address
rep("var SHARE_BASE='https://claude.ai/artifact/QSxkYT7bfu2HT7c44yaQni';","var SHARE_BASE=window.SHRISHTI_BASE||(location.origin+location.pathname);")
# 2. sign-in goes through the adapter, then the app re-reads who the user is
rep("""$('#googleBtn').addEventListener('click',async function(){
  enterApp();""","""$('#googleBtn').addEventListener('click',async function(){
  if(window.shrishtiAuth){
    var signedIn=await window.shrishtiAuth();
    if(!signedIn)return;
    initPromise=initCapabilities();
  }
  enterApp();""")
rep("  closeOm();closeShare();leaveKaal();\n","  closeOm();closeShare();leaveKaal();\n  if(window.shrishtiLogout)window.shrishtiLogout();\n")
# 3. wording that only made sense inside Claude
rep("Research needs Claude access, which is not available on this page. Open it from Claude to plant seeds.","Research is not available: the server has no Gemini API key configured.")
rep("Asking needs Claude access on this page, which is not available here.","Questions are not available: the server has no Gemini API key configured.")
rep("Opening a shared galaxy needs you to be signed in to Claude on this page.","Opening a shared galaxy needs you to be signed in.")
rep("<p>Sharing needs you to be signed in to Claude on this page.</p>","<p>Sharing needs you to be signed in.</p>")
rep("""if(rec&&S.db)h+='<p class="note">This page is private to you until you share it. Use the Share menu on claude.ai to give people access to the page, or they will not be able to open the link.</p>';""","""if(rec&&S.db)h+='<p class="note">Anyone with the link who signs in with Google can open it. Stop sharing to switch the link off.</p>';""")
rep("Claude access was declined for this page, so research cannot run.","Research is not available right now.")
rep("Claude access was declined for this page, so questions cannot be answered.","Questions are not available right now.")
# 4. wrap in a real document
i=src.index('<div id="app"')
head,body=src[:i],src[i:]
body=body.replace('<script src="https://cdnjs.cloudflare.com','<script src="/shim.js"></script>\n<script src="https://cdnjs.cloudflare.com',1)
doc='''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23080b0d'/%3E%3Ccircle cx='16' cy='16' r='6' fill='%23c9975a'/%3E%3C/svg%3E">
<style>
:root{color-scheme:dark}
html,body{margin:0;background:#080b0d}
[hidden]{display:none!important}
img{max-width:100%}
</style>
'''+head+'</head>\n<body>\n'+body+'\n</body>\n</html>\n'
open(sys.argv[2],'w',encoding='utf-8').write(doc)
print('built',len(doc))
