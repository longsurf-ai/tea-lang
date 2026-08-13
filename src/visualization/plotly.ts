// Purpose: Offline Plotly browser adapter for renderer-neutral sweep scenes.

import type {SweepRenderer, SweepRendererModel} from './renderer';

export const PLOTLY_ASSET_PATH = '/assets/plotly-gl3d.min.js';

export class PlotlySweepRenderer implements SweepRenderer {
  document(model: SweepRendererModel) {
    return {
      contentType: 'text/html; charset=utf-8' as const,
      body: renderPlotlyDocument(model),
    };
  }
}

function renderPlotlyDocument(model: SweepRendererModel): string {
  const encoded = jsonForScript(model);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tea sweep surface</title>
  <style>
    :root { color-scheme: dark; --ink:#eef2e8; --muted:#8e9a8c; --line:#2b332d; --panel:#131816; --acid:#c8ff42; --ember:#ff7848; }
    * { box-sizing:border-box; }
    html,body { height:100%; margin:0; }
    body { overflow:hidden; background:#090c0a; color:var(--ink); font-family:"Avenir Next Condensed","DIN Condensed","Helvetica Neue",sans-serif; }
    body::before { content:""; position:fixed; inset:0; pointer-events:none; opacity:.12; background-image:linear-gradient(rgba(255,255,255,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.04) 1px,transparent 1px); background-size:36px 36px; mask-image:linear-gradient(to bottom,black,transparent 80%); }
    main { position:relative; height:100%; display:grid; grid-template-rows:auto 1fr; padding:22px 26px 26px; gap:14px; }
    header { display:flex; align-items:flex-end; justify-content:space-between; gap:24px; }
    .eyebrow { color:var(--acid); font-size:11px; font-weight:700; letter-spacing:.22em; text-transform:uppercase; }
    h1 { margin:3px 0 0; font-size:clamp(28px,4vw,54px); line-height:.9; font-weight:650; letter-spacing:-.035em; }
    .meta { text-align:right; white-space:pre-line; color:var(--muted); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; line-height:1.6; }
    .workspace { min-height:0; display:grid; grid-template-columns:minmax(0,1fr) 224px; border:1px solid var(--line); background:linear-gradient(145deg,#111713,#0b0e0c 62%); box-shadow:0 30px 90px rgba(0,0,0,.4); }
    .stage { min-height:0; position:relative; background:radial-gradient(circle at 68% 18%,rgba(200,255,66,.07),transparent 32%); }
    .stage::after { content:"TEA / PARAMETER FIELD"; position:absolute; left:18px; bottom:14px; z-index:2; color:#536056; font:10px ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.16em; pointer-events:none; }
    #plot { width:100%; height:100%; min-height:420px; }
    aside { border-left:1px solid var(--line); padding:18px; overflow:auto; background:rgba(9,12,10,.72); }
    .control { margin-bottom:17px; }
    label { display:block; margin-bottom:6px; color:var(--muted); font-size:10px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; }
    select { width:100%; border:1px solid #364039; border-radius:0; padding:9px 30px 9px 10px; color:var(--ink); background:#111713; font:12px ui-monospace,SFMono-Regular,Menlo,monospace; outline:none; }
    select:focus { border-color:var(--acid); box-shadow:0 0 0 1px var(--acid); }
    .divider { height:1px; margin:20px 0; background:var(--line); }
    #status { color:var(--muted); font:10px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
    .error { padding:28px; color:#ffad93; font:13px ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; }
    @media (max-width:760px) { body { overflow:auto; } main { min-height:100%; } .workspace { grid-template-columns:1fr; } aside { border-left:0; border-top:1px solid var(--line); } }
  </style>
</head>
<body>
  <main>
    <header>
      <div><div class="eyebrow">Strategy sweep / parameter field</div><h1 id="title">${escapeHtml(model.initialScene.z.label)}</h1></div>
      <div class="meta" id="meta"></div>
    </header>
    <section class="workspace">
      <div class="stage"><div id="plot"></div></div>
      <aside>
        <div class="control"><label for="x">X parameter</label><select id="x"></select></div>
        <div class="control"><label for="y">Y parameter</label><select id="y"></select></div>
        <div class="control"><label for="metric">Metric</label><select id="metric"></select></div>
        <div class="control"><label for="geometry">Geometry</label><select id="geometry"><option value="auto">Auto</option><option value="surface">Surface</option><option value="scatter3d">Points</option></select></div>
        <div class="divider"></div><div id="slices"></div><div id="status"></div>
      </aside>
    </section>
  </main>
  <script src="${PLOTLY_ASSET_PATH}"></script>
  <script>
    const model = ${encoded};
    let scene = model.initialScene;
    const colorscale = [[0,"#ff7848"],[.28,"#f1b84b"],[.52,"#dce982"],[.72,"#8fe388"],[1,"#c8ff42"]];
    const common = () => ({colorscale, colorbar:{title:{text:scene.z.label}, thickness:12, outlinewidth:0, tickfont:{color:"#8e9a8c"}, titlefont:{color:"#eef2e8"}}});
    const axis = title => ({title:{text:title,font:{color:"#eef2e8"}},gridcolor:"#2b332d",zerolinecolor:"#465049",tickfont:{color:"#8e9a8c"},backgroundcolor:"rgba(0,0,0,0)"});
    function options(select, values, selected, label) { select.replaceChildren(...values.map(value => { const option=document.createElement("option"); option.value=value.id; option.textContent=label(value); option.selected=value.id===selected; return option; })); }
    const x=document.getElementById("x"), y=document.getElementById("y"), metric=document.getElementById("metric"), geometry=document.getElementById("geometry"), slices=document.getElementById("slices"), status=document.getElementById("status");
    options(x,model.axes,model.initialSpec.xParameterId,v=>v.label); options(y,model.axes,model.initialSpec.yParameterId,v=>v.label); options(metric,model.metrics,model.initialSpec.zMetricId,v=>v.label); geometry.value=model.initialSpec.geometry;
    function rebuildSlices(previous={}) { slices.replaceChildren(); for (const item of model.axes) { if (item.id===x.value||item.id===y.value) continue; const wrap=document.createElement("div"); wrap.className="control"; const lab=document.createElement("label"); lab.textContent="Slice · "+item.label; const select=document.createElement("select"); select.dataset.axis=item.id; for(const value of item.values){const option=document.createElement("option");option.value=String(value);option.textContent=String(value);option.selected=String(previous[item.id]??item.values[0])===String(value);select.append(option);} select.addEventListener("change",update); wrap.append(lab,select); slices.append(wrap); } }
    function spec(){ const selectedSlices={}; for(const select of slices.querySelectorAll("select")) selectedSlices[select.dataset.axis]=Number(select.value); return {xParameterId:x.value,yParameterId:y.value,zMetricId:metric.value,slices:selectedSlices,geometry:geometry.value}; }
    function draw(){ const trace=scene.geometry==="surface"?{...common(),type:"surface",x:scene.x.values,y:scene.y.values,z:scene.z.values,connectgaps:false,contours:{z:{show:true,usecolormap:true,project:{z:true}}},hovertemplate:scene.x.label+": %{x}<br>"+scene.y.label+": %{y}<br>"+scene.z.label+": %{z}<extra></extra>"}:{...common(),type:"scatter3d",mode:"markers",x:scene.points.map(p=>p.x),y:scene.points.map(p=>p.y),z:scene.points.map(p=>p.z),marker:{size:5,color:scene.points.map(p=>p.z),colorscale,opacity:.9,line:{color:"#090c0a",width:1}},customdata:scene.points.map(p=>p.bindingIndex),hovertemplate:scene.x.label+": %{x}<br>"+scene.y.label+": %{y}<br>"+scene.z.label+": %{z}<br>execution: %{customdata}<extra></extra>"}; document.getElementById("title").textContent=scene.z.label; document.getElementById("meta").textContent="X · "+scene.x.label+"\\nY · "+scene.y.label+"\\n"+scene.scenarioCount+" scenarios"; return Plotly.react("plot",[trace],{paper_bgcolor:"rgba(0,0,0,0)",plot_bgcolor:"rgba(0,0,0,0)",margin:{l:8,r:8,t:8,b:8},scene:{xaxis:axis(scene.x.label),yaxis:axis(scene.y.label),zaxis:axis(scene.z.label),bgcolor:"rgba(0,0,0,0)",camera:{eye:{x:1.55,y:1.55,z:1.08}},aspectmode:"auto"}},{responsive:true,displaylogo:false,scrollZoom:true}); }
    async function update(){status.textContent="PROJECTING…"; try {const response=await fetch("/scene",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(spec())}); const payload=await response.json(); if(!response.ok)throw new Error(payload.error??"projection failed"); scene=payload; await draw();status.textContent=scene.geometry.toUpperCase()+" · "+scene.scenarioCount+" SCENARIOS";}catch(error){status.textContent=String(error);}}
    function separateAxes(changed){ if(x.value!==y.value)return; const target=changed===x?y:x; const replacement=[...target.options].find(option=>option.value!==changed.value); if(replacement)target.value=replacement.value; }
    x.addEventListener("change",()=>{separateAxes(x);rebuildSlices();update();}); y.addEventListener("change",()=>{separateAxes(y);rebuildSlices();update();}); metric.addEventListener("change",update); geometry.addEventListener("change",update); rebuildSlices(model.initialSpec.slices); draw().then(()=>status.textContent=scene.geometry.toUpperCase()+" · "+scene.scenarioCount+" SCENARIOS").catch(error=>{status.textContent=String(error);});
  </script>
</body>
</html>`;
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
