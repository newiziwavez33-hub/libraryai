


/* === PATCH v22-popup: Animated book popup loader === */
(function(){
  function createLoadingPopup(){
    if(document.getElementById('laBookLoader')) return;
    const overlay=document.createElement('div');
    overlay.id='laBookLoader';
    overlay.style.position='fixed';
    overlay.style.inset='0';
    overlay.style.background='rgba(0,0,0,0.85)';
    overlay.style.zIndex='999999';
    overlay.style.display='flex';
    overlay.style.alignItems='center';
    overlay.style.justifyContent='center';
    overlay.style.flexDirection='column';
    overlay.style.transition='opacity 0.6s ease';
    const style=document.createElement('style');
    style.textContent=`
    @keyframes flyBooks {
      0% { transform: translateY(40px) scale(0.8); opacity:0; }
      30% { transform: translateY(0px) scale(1); opacity:1; }
      70% { transform: translateY(-20px) scale(1); opacity:0.8; }
      100% { transform: translateY(-40px) scale(0.8); opacity:0; }
    }
    .book-thumb {
      position:absolute;
      width:80px;
      height:120px;
      border-radius:6px;
      box-shadow:0 0 8px rgba(255,255,255,0.2);
      animation: flyBooks 4s infinite;
      opacity:0;
    }
    #laBookLoaderText {
      color:#fff;
      font-size:18px;
      font-weight:600;
      margin-top:180px;
      text-shadow:0 0 6px rgba(0,0,0,0.8);
    }
    `;
    document.head.appendChild(style);
    const container=document.createElement('div');
    container.id='laBookLoaderContainer';
    container.style.position='relative';
    container.style.width='100%';
    container.style.height='200px';
    overlay.appendChild(container);
    const text=document.createElement('div');
    text.id='laBookLoaderText';
    text.textContent='📚 Загружаем книги из библиотеки LibraryAI...';
    overlay.appendChild(text);
    document.body.appendChild(overlay);
  }

  function showLoadingPopup(thumbnails){
    createLoadingPopup();
    const container=document.getElementById('laBookLoaderContainer');
    container.innerHTML='';
    // create animated thumbnails
    const count=thumbnails && thumbnails.length? Math.min(thumbnails.length,8):8;
    for(let i=0;i<count;i++){
      const img=document.createElement('img');
      img.src=thumbnails[i]||'https://via.placeholder.com/80x120?text=Book';
      img.className='book-thumb';
      img.style.left=`${Math.random()*80+10}%`;
      img.style.top=`${Math.random()*60+10}px`;
      img.style.animationDelay=`${i*0.4}s`;
      container.appendChild(img);
    }
    const overlay=document.getElementById('laBookLoader');
    overlay.style.opacity='1';
    overlay.style.display='flex';
  }

  function hideLoadingPopup(){
    const overlay=document.getElementById('laBookLoader');
    if(!overlay) return;
    overlay.style.opacity='0';
    setTimeout(()=>{ overlay.remove(); },700);
  }

  // Hook into loadBooks and renderBooks
  const origLoadBooks=window.loadBooks;
  window.loadBooks=async function(...args){
    try{ showLoadingPopup([]); }catch(e){}
    const res=await origLoadBooks.apply(this,args);
    try{ hideLoadingPopup(); }catch(e){}
    return res;
  };

  const origRenderBooks=window.renderBooks;
  window.renderBooks=async function(...args){
    const res=await origRenderBooks.apply(this,args);
    try{ hideLoadingPopup(); }catch(e){}
    return res;
  };

})(); /* end popup patch */



/* === PATCH v22-highZ: Ensure all popups are always on top === */
(function(){
  const highZ = 999999;
  function raisePopups(){
    const selectors = [
      '[class*="popup"]',
      '[id*="Popup"]',
      '[class*="overlay"]',
      '[id*="Overlay"]',
      '[class*="modal"]',
      '[id*="modal"]',
      '#laBookLoader',
      '#welcomeOverlay',
      '#linksPopup',
      '#dianaPopup'
    ];
    selectors.forEach(sel=>{
      document.querySelectorAll(sel).forEach(el=>{
        el.style.zIndex = highZ;
      });
    });
  }
  const observer = new MutationObserver(raisePopups);
  observer.observe(document.body,{childList:true,subtree:true});
  window.addEventListener('DOMContentLoaded',raisePopups);
  window.addEventListener('load',raisePopups);
})();
