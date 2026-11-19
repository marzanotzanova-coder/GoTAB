/* Admin-only report export. All report data stays in the current browser. */
(function(root){
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const math=s=>root.GoTabMath.render(String(s??''));
  function sections(a){
    const when=new Date(a.created_at).toLocaleString('kk-KZ',{timeZone:'Asia/Almaty'});
    const result=[`<div class="pdf-brand">GoTAB · НӘТИЖЕ ЕСЕБІ</div><h1>${esc(a.student_name||a.student_id)}</h1><p>${Number(a.lesson_number)===0?'Диагностикалық тест':'Сабақ '+esc(a.lesson_number)} · ${esc(when)}</p><p>Оқушы ID: ${esc(a.student_id)} · Талпыныс №${esc(a.id)}</p>`,
      `<div class="pdf-stats"><div><b>${esc(a.correct_count)}/${esc(a.total_count)}</b>Нәтиже</div><div><b>${esc(a.correct_count)}</b>Дұрыс</div><div><b>${esc(a.wrong_count)}</b>Қате</div><div><b>${esc(a.percentage)}%</b>Пайыз</div></div>`];
    const topics=Object.entries(a.topic_breakdown||{});
    if(topics.length){
      result.push('<h2>Тақырыптар бойынша нәтиже</h2>');
      for(let i=0;i<topics.length;i+=6)result.push('<table><thead><tr><th>Тақырып</th><th>Дұрыс / Барлығы</th><th>Пайыз</th></tr></thead><tbody>'+topics.slice(i,i+6).map(([topic,d])=>`<tr><td>${esc(topic)}</td><td>${esc(d.correct)} / ${esc(d.total)}</td><td>${esc(d.percentage)}%</td></tr>`).join('')+'</tbody></table>');
    }
    const wrong=a.wrong_questions||[];
    result.push('<h2>Қате жіберілген сұрақтар</h2>');
    if(!wrong.length)result.push('<p>Барлық жауап дұрыс.</p>');
    wrong.forEach((q,i)=>result.push(`<div class="pdf-question"><h3>${Number.isInteger(q.idx)?q.idx+1:i+1}. ${math(q.question)}</h3><p class="pdf-muted">Тақырып: ${esc(q.topic)}</p><p class="pdf-correct">Дұрыс жауап: ${math(q.correct)}</p><p class="pdf-wrong">Оқушы жауабы: ${math(q.studentAnswer||'(жауап берілмеді)')}</p></div>`));
    result.push('<h2>ЖИ диагностикасы</h2>');
    if(!a.ai_diagnosis)result.push('<p>ЖИ талдауы әлі дайын емес. Дайын болғаннан кейін есепті қайта жүктеңіз.</p>');
    else for(const line of String(a.ai_diagnosis).split(/\n+/).filter(s=>s.trim())){
      // Keep long prose blocks below one page, without slicing rendered text.
      const chunks=line.replace(/\*\*/g,'').match(/[\s\S]{1,800}(?:\s|$)|[\s\S]{1,800}/g)||[];
      chunks.forEach(t=>result.push('<p class="pdf-analysis">'+math(t)+'</p>'));
    }
    if(a.teacher_advice)result.push('<h2>Мұғалімге ұсыныс</h2><p>'+math(a.teacher_advice)+'</p>');
    return result;
  }
  async function download(a,onProgress){
    if(!root.jspdf?.jsPDF||!root.html2canvas)throw Error('PDF кітапханасы жүктелмеді. Бетті жаңартыңыз.');
    const report=document.createElement('div');report.className='gotab-pdf-report';
    report.style.cssText='position:absolute;left:-12000px;top:0;width:760px;background:white;color:#17243e;font:15px/1.55 Arial,sans-serif;';
    const style=document.createElement('style');style.textContent=`.gotab-pdf-report *{box-sizing:border-box}.gotab-pdf-report section{padding:5px 8px 9px;background:#fff}.gotab-pdf-report h1{font-size:28px;line-height:1.3;margin:9px 0}.gotab-pdf-report h2{font-size:20px;color:#2255bc;margin:15px 0 6px}.gotab-pdf-report h3{font-size:16px;line-height:1.7;margin:4px 0;overflow-wrap:anywhere}.gotab-pdf-report p{margin:6px 0}.pdf-brand{font-size:13px;font-weight:bold;color:#2f6bff;letter-spacing:1px}.pdf-stats{display:flex;gap:12px}.pdf-stats>div{flex:1;padding:15px;background:#f1f5ff;border-radius:10px;text-align:center}.pdf-stats b{display:block;font-size:27px;color:#2f6bff}.gotab-pdf-report table{border-collapse:collapse;width:100%;font-size:14px}.gotab-pdf-report th,.gotab-pdf-report td{border:1px solid #dfe6f3;padding:9px;text-align:left}.gotab-pdf-report th{background:#edf3ff}.pdf-question{padding:12px 14px;border:1px solid #dfe6f3;border-radius:10px}.pdf-muted{color:#68758b;font-size:13px}.pdf-correct{color:#087b5e}.pdf-wrong{color:#b32e38}.pdf-analysis{white-space:pre-wrap}.gotab-pdf-report .katex{font-size:1.08em}`;
    document.head.appendChild(style);document.body.appendChild(report);
    try{
      const blocks=sections(a).map(html=>{const el=document.createElement('section');el.innerHTML=html;report.appendChild(el);return el;});
      await document.fonts.ready;
      await Promise.all(Array.from(report.querySelectorAll('img')).map(img=>img.decode()));
      const pdf=new root.jspdf.jsPDF({orientation:'portrait',unit:'mm',format:'a4',compress:true});
      pdf.setProperties({title:'GoTAB — '+String(a.student_name||a.student_id),subject:'Diagnostic test result',creator:'GoTAB'});
      const margin=14,width=182,bottom=280,maxPixels=(bottom-margin)*760/width;
      // Lay out whole sections on A4 pages before rendering: no sliced letters or formulas.
      const pagesDOM=[];let page=document.createElement('div'),used=0;
      page.style.background='#fff';
      const measured=blocks.map(el=>el.getBoundingClientRect().height);
      report.replaceChildren();
      for(let i=0;i<blocks.length;i++){
        const keepNext=!!blocks[i].querySelector('h2')&&i+1<blocks.length;
        const reserve=keepNext?measured[i+1]:0;
        if(used>0&&used+measured[i]+reserve>maxPixels){pagesDOM.push(page);page=document.createElement('div');page.style.background='#fff';used=0;}
        page.appendChild(blocks[i]);used+=measured[i];
      }
      if(page.children.length)pagesDOM.push(page);
      for(let i=0;i<pagesDOM.length;i++){
        onProgress?.(i+1,pagesDOM.length);
        report.replaceChildren(pagesDOM[i]);
        const canvas=await root.html2canvas(pagesDOM[i],{scale:2,backgroundColor:'#ffffff',logging:false,useCORS:true,windowWidth:1000});
        let w=width,h=canvas.height*width/canvas.width;
        if(h>bottom-margin){w*=(bottom-margin)/h;h=bottom-margin;}
        if(i>0)pdf.addPage();
        pdf.addImage(canvas.toDataURL('image/png'),'PNG',margin,margin,w,h,undefined,'FAST');
        canvas.width=canvas.height=0;
      }
      const pages=pdf.getNumberOfPages();
      for(let n=1;n<=pages;n++){pdf.setPage(n);pdf.setFontSize(9);pdf.setTextColor(110);pdf.text('GoTAB  |  '+n+' / '+pages,196,290,{align:'right'});}
      const safe=String(a.student_name||a.student_id||'student').replace(/[^\p{L}\p{N}_-]+/gu,'_').slice(0,70);
      await pdf.save('GoTAB_'+safe+'_result_'+a.id+'.pdf',{returnPromise:true});
      return {pages};
    }finally{report.remove();style.remove();}
  }
  root.GoTabAttemptPdf={download,sections};
})(window);
