let adminPassword = "";
const $ = id => document.getElementById(id);
async function api(path, options={}) {
  const response = await fetch(path, { ...options, headers: { "Content-Type":"application/json", "x-admin-password":adminPassword, ...(options.headers||{}) } });
  if (!response.ok) throw new Error((await response.json().catch(()=>({error:"Request failed"}))).error || "Request failed");
  return response.json();
}
$("connect").addEventListener("click", async () => {
  adminPassword = $("password").value;
  try {
    const state = await api("/api/admin/state");
    $("loginPanel").hidden = true; $("dashboard").hidden = false; $("connection").textContent = "Connected";
    Object.keys(state).forEach(k => { const el=$(k); if(el) { if(el.type==="checkbox") el.checked=!!state[k]; else el.value=state[k] ?? ""; } });
    loadMessages();
  } catch(e) { $("connection").textContent = e.message; }
});
$("save").addEventListener("click", async () => {
  const data={};
  ["availability","aiEnabled","humanTakeover","businessName","greeting","awayMessage","handoverMessage","systemPrompt","knowledgeBase"].forEach(k=>{
    const el=$(k); data[k]=el.type==="checkbox"?el.checked:el.value;
  });
  try { await api("/api/admin/state",{method:"POST",body:JSON.stringify(data)}); $("saved").textContent="Settings saved."; }
  catch(e){$("saved").textContent=e.message;}
});
async function loadMessages(){
  try {
    const rows=await api("/api/admin/messages");
    $("messages").innerHTML=rows.length?rows.map(m=>`<div class="message"><small>${escapeHtml(m.at||"")} · ${escapeHtml(m.direction||"")} · ${escapeHtml(m.from||m.to||"")}</small>${escapeHtml(m.text||JSON.stringify(m.error||""))}</div>`).join(""):"No messages recorded yet.";
  } catch(e){$("messages").textContent=e.message;}
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
$("refresh").addEventListener("click",loadMessages);
