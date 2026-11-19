/* DOCX is read locally. No file is uploaded until the existing Save action. */
(function(root){
  const M='http://schemas.openxmlformats.org/officeDocument/2006/math';
  const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const kids=n=>Array.from(n?.children||[]);
  const child=(n,name)=>kids(n).find(c=>c.localName===name);
  function texText(t){return t.replace(/\\/g,'\\backslash ').replace(/[{}#$%&_]/g,c=>'\\'+c).replace(/−/g,'-').replace(/×/g,'\\times ').replace(/÷/g,'\\div ').replace(/≤/g,'\\le ').replace(/≥/g,'\\ge ').replace(/≠/g,'\\ne ').replace(/π/g,'\\pi ').replace(/∞/g,'\\infty ');}
  function math(n){
    if(!n)return '';
    const name=n.localName, get=k=>math(child(n,k)), all=()=>kids(n).map(math).join('');
    if(name.endsWith('Pr'))return '';
    if(name==='t')return texText(n.textContent);
    if(name==='f')return '\\frac{'+get('num')+'}{'+get('den')+'}';
    if(name==='sSup')return '{'+get('e')+'}^{'+get('sup')+'}';
    if(name==='sSub')return '{'+get('e')+'}_{'+get('sub')+'}';
    if(name==='sSubSup')return '{'+get('e')+'}_{'+get('sub')+'}^{'+get('sup')+'}';
    if(name==='rad'){const d=get('deg');return '\\sqrt'+(d?'['+d+']':'')+'{'+get('e')+'}';}
    if(name==='d'){
      const pr=child(n,'dPr'), val=(key,fallback)=>child(pr,key)?.getAttributeNS(M,'val')??fallback;
      const delim=s=>({'{':'\\{','}':'\\}','':' .'}[s]??s);
      return '\\left'+delim(val('begChr','('))+' '+kids(n).filter(c=>c.localName==='e').map(math).join(' \\mid ')+' \\right'+delim(val('endChr',')'));
    }
    if(name==='eqArr')return '\\begin{aligned}'+kids(n).filter(c=>c.localName==='e').map(math).join('\\\\')+'\\end{aligned}';
    if(name==='m')return '\\begin{matrix}'+kids(n).filter(c=>c.localName==='mr').map(r=>kids(r).filter(c=>c.localName==='e').map(math).join('&')).join('\\\\')+'\\end{matrix}';
    if(name==='nary'){
      const pr=child(n,'naryPr'), chr=child(pr,'chr')?.getAttributeNS(M,'val')||'∫';
      const op={'∫':'\\int','∑':'\\sum','∏':'\\prod','⋃':'\\bigcup','⋂':'\\bigcap'}[chr];
      if(!op)throw Error('Қолдау көрсетілмеген қосынды/интеграл белгісі: '+chr);
      return op+(get('sub')?'_{'+get('sub')+'}':'')+(get('sup')?'^{'+get('sup')+'}':'')+' '+get('e');
    }
    if(name==='limLow')return get('e')+'_{'+get('lim')+'}';
    if(name==='limUpp')return get('e')+'^{'+get('lim')+'}';
    if(name==='bar')return '\\overline{'+get('e')+'}';
    if(name==='acc'){
      const chr=child(child(n,'accPr'),'chr')?.getAttributeNS(M,'val')||'̂';
      const op={'̂':'hat','⃗':'vec','̅':'bar','̃':'tilde','̇':'dot','̈':'ddot'}[chr];
      if(!op)throw Error('Формуладағы екпін белгісі қолдау көрсетілмейді.');
      return '\\'+op+'{'+get('e')+'}';
    }
    if(['oMath','oMathPara','r','e','num','den','sup','sub','deg','fName','func','lim','box'].includes(name))return all();
    throw Error('Қолдау көрсетілмеген формула түрі: '+name+'. Құжатты сақтамай, осы формуланы тексеріңіз.');
  }
  function paragraph(p){
    function walk(n){
      if(n.namespaceURI===M&&(n.localName==='oMath'||n.localName==='oMathPara'))return '$'+math(n)+'$';
      if(n.namespaceURI===W&&n.localName==='t')return n.textContent;
      if(n.namespaceURI===W&&['tab','br','cr'].includes(n.localName))return n.localName==='tab'?'\t':'\n';
      if(['drawing','object','pict'].includes(n.localName))throw Error('Құжатта сурет немесе ескі Equation объектісі бар. Оны Word формуласына ауыстырыңыз.');
      if(['del','pPr','rPr'].includes(n.localName))return '';
      // Preserve superscript/subscript typed as formatted text too.
      if(n.namespaceURI===W&&n.localName==='r'){
        const align=child(child(n,'rPr'),'vertAlign')?.getAttributeNS(W,'val');
        const t=kids(n).filter(c=>c.localName!=='rPr').map(walk).join('');
        if(align==='superscript')return '$^{'+texText(t)+'}$';
        if(align==='subscript')return '$_{'+texText(t)+'}$';
        return t;
      }
      return kids(n).map(walk).join('');
    }
    return walk(p).trim();
  }
  function extract(xml){
    const doc=new DOMParser().parseFromString(xml,'application/xml');
    if(doc.getElementsByTagName('parsererror').length)throw Error('Word құжатының құрылымы оқылмады.');
    return Array.from(doc.getElementsByTagNameNS(W,'p')).filter(p=>!p.parentElement?.closest?.('w\\:p')).map(paragraph).filter(Boolean).join('\n');
  }
  function tagged(text){
    if(/^\s*<q[a-z]+>/im.test(text))return text;
    // Numbered questions, A–E options, explicit correct marker or answer key.
    const lines=text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
    const key={}, questions=[];let current=null, keys=false;
    for(const line of lines){
      if(/^(жауаптар|дұрыс жауаптар|ответы|answer key)\s*:?$/i.test(line)){keys=true;continue;}
      if(keys){for(const m of line.matchAll(/(\d+)\s*[).:\-–—]?\s*([A-EАВСДЕ])/gi))key[m[1]]=m[2].toUpperCase();continue;}
      const q=line.match(/^(\d+)[.)]\s+(.+)/);
      if(q){current={n:q[1],question:q[2],options:[]};questions.push(current);continue;}
      if(!current)continue;
      const a=line.match(/^([A-EАВСДЕ])[).:]\s*(.*)/i);
      if(a){current.options.push({label:a[1].toUpperCase(),text:a[2].replace(/\s*[✓✔✅]\s*$/,'').trim(),correct:/[✓✔✅]\s*$/.test(a[2])});continue;}
      if(current.options.length)current.options.at(-1).text+=' '+line;else current.question+=' '+line;
    }
    if(!questions.length)throw Error('Сұрақтар табылмады. 1. Сұрақ, A) жауап пішімін немесе <question>/<answer>/<variant> белгілерін қолданыңыз.');
    return questions.map(q=>{
      const correct=q.options.filter(o=>o.correct||key[q.n]===o.label);
      if(correct.length!==1)throw Error('№'+q.n+' сұрақтың дұрыс жауабы белгіленбеген немесе бірнеше жауап белгіленген. Дұрыс нұсқаның соңына ✓ қойыңыз немесе «Жауаптар» бөлімін қосыңыз.');
      if(q.options.length<2)throw Error('№'+q.n+' сұраққа кемінде екі жауап нұсқасы керек.');
      return '<question>'+q.question+'\n<answer>'+correct[0].text+'\n'+q.options.filter(o=>o!==correct[0]).map(o=>'<variant>'+o.text).join('\n');
    }).join('\n\n');
  }
  async function read(file){
    if(!/\.docx$/i.test(file.name))throw Error('Word құжатын .docx түрінде сақтап, қайта таңдаңыз.');
    if(file.size>10*1024*1024)throw Error('Құжат 10 МБ-тан аспауы керек.');
    if(!root.JSZip)throw Error('Word оқу кітапханасы жүктелмеді. Бетті жаңартыңыз.');
    const zip=await root.JSZip.loadAsync(await file.arrayBuffer());
    const entry=zip.file('word/document.xml');if(!entry)throw Error('Бұл жарамды Word .docx құжаты емес.');
    const xml=await entry.async('string');if(xml.length>5000000)throw Error('Құжат тым үлкен. Тестті бірнеше құжатқа бөліңіз.');
    return tagged(extract(xml));
  }
  root.GoTabDocx={read,extract,tagged,math};
  if(typeof module!=='undefined')module.exports=root.GoTabDocx;
})(typeof window!=='undefined'?window:globalThis);
