import{h}from"./index-3-libOPS.js";import{compressImage as f}from"./image-BsXlhtET.js";import"./vendor-markdown-DkZTs8jq.js";import"./vendor-react-CfjWFXXn.js";import"./vendor-state-D0g0rz4W.js";import"./vendor-tauri-DP7f-jEB.js";class b{constructor(e){this.gateway=e}async verify(e,s,m,p,r){const u=await f(s),o=[];r&&r.length>0&&o.push(...r),o.push({role:"user",content:[{type:"image_url",image_url:{url:u.dataUrl}},{type:"text",text:`Original goal: "${e}"

Look at the screenshot above. Is the goal FULLY completed?

Answer with ONLY one word on the first line: YES or NO.
If NO, describe what is still missing on the next line.

Be strict: even small issues mean the task is NOT complete. Do NOT use any tool — just answer in plain text.`}]});let c="";for await(const t of this.gateway.chatStream({scenario:h.desktopAutomation,messages:o,provider:m,apiKey:p,tools:void 0,goal:e,skipCache:!0})){if(t.startsWith("__ERROR__:"))return console.log(`[VerificationAgent] error: ${t.substring(10)} — trusting agent`),{completed:!0,feedback:"Verification error — trusted agent",screenshot:s};t.startsWith("__REASONING__:")||t.startsWith("__TOOLS__:")||(c+=t)}const i=c.trim(),n=i.split(`
`)[0]?.trim().toUpperCase()??"",a=n==="YES"||n.startsWith("YES"),l=a?"Task verified complete":n.startsWith("NO")?i.substring(i.indexOf(`
`)+1).trim()||"Task appears incomplete":i||"Task appears incomplete";return console.log(`[VerificationAgent] ${a?"✓":"✗"} ${l.substring(0,120)}`),{completed:a,feedback:l,screenshot:s}}}export{b as VerificationAgent};
