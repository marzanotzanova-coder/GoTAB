/* Shared, escaped formula rendering for admin previews and student quizzes. */
(function(root){
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  function legacy(s){
    // Only convert a whole run of quoted math tokens; preserve ordinary quoted prose.
    return s.replace(/(?:"[^"\n]*"[ \t()+\-*/^=?:.,]*){2,}/g, run => {
      const plain=run.replace(/"/g,'').trim();
      if(!/[\d]/.test(plain)||!/^[\s\da-zA-Zα-ωΑ-Ω+\-−×÷*/^=().,:?√π{}]+$/.test(plain))return run;
      let t=run.replace(/"([^"\n]+)"\s*\/\s*"([^"\n]+)"/g,(_,a,b)=>'\\frac{'+a+'}{'+b+'}')
        .replace(/"([^"\n]+)"\s*\^\s*"([^"\n]+)"/g,(_,a,b)=>a+'^{'+b+'}').replace(/"/g,'');
      return '$'+t+'$';
    });
  }
  function render(text){
    const s=String(text??'');
    const imageParts=s.split(/(\[IMG:images\/[A-Za-z0-9_-]+\.(?:png|jpe?g|webp)\])/gi);
    if(imageParts.length>1)return imageParts.map((part,i)=>i%2
      ? '<img src="'+part.slice(5,-1)+'" alt="Сұрақтың геометриялық сызбасы" style="display:block;max-width:100%;width:340px;height:auto;margin:16px auto">'
      : render(part)).join('');
    return legacy(s).split(/(\$\$[\s\S]+?\$\$|\$[^$\n]+\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\])/g).map(part=>{
      const isMath=/^(\$|\\\(|\\\[)/.test(part);
      if(!isMath)return esc(part).replace(/\n/g,'<br>');
      const display=part.startsWith('$$')||part.startsWith('\\[');
      const formula=part.startsWith('$$')?part.slice(2,-2):part.startsWith('$')?part.slice(1,-1):part.slice(2,-2);
      if(!root.katex)return '<span title="Формула кітапханасы жүктелмеді">'+esc(formula)+'</span>';
      try{return root.katex.renderToString(formula,{throwOnError:true,trust:false,strict:'warn',displayMode:display,maxExpand:1000});}
      catch(e){return '<span class="formula-error" title="Формуланы тексеріңіз">'+esc(formula)+'</span>';}
    }).join('');
  }
  root.GoTabMath={render,legacy};
  if(typeof module!=='undefined')module.exports={render,legacy};
})(typeof window!=='undefined'?window:globalThis);
