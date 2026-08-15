// ═══════════════════════════════════════════════════════════
//  YOLO 标注工作台  —  独立窗口
//  画布：缩放/平移/画框/选择/拖拽/八向缩放；类别管理；YOLO txt 读写
//  原生依赖：yolo_list_images / yolo_read_image / yolo_read_text /
//            yolo_write_text / yolo_pick_dir
// ═══════════════════════════════════════════════════════════
(function () {
  'use strict';
  var invoke = JADE.invoke, esc = JADE.esc, $ = JADE.$;
  var PALETTE = ['#ef4444','#3b82f6','#22c55e','#f59e0b','#a855f7','#06b6d4',
    '#ec4899','#84cc16','#f97316','#14b8a6','#6366f1','#eab308',
    '#f43f5e','#0ea5e9','#10b981','#d946ef'];
  function clsColor(i){ return PALETTE[((i%PALETTE.length)+PALETTE.length)%PALETTE.length]; }
  var HANDLES=['nw','n','ne','e','se','s','sw','w'];

  var S = {
    dir:'', images:[], idx:-1, img:null, imgW:0, imgH:0,
    boxes:[], classes:[], curClass:0, tool:'select',
    view:{scale:1,ox:0,oy:0}, sel:-1, hover:-1, showBoxes:true, dirty:false,
    undo:[], redo:[], drag:null, spaceDown:false, autoSave:true
  };
  var cv, ctx, host;

  // ── 主题同步 ──
  function applyTheme(){ document.body.dataset.theme = localStorage.getItem('theme')||'glass'; }
  window.addEventListener('storage',function(e){ if(e.key==='theme')applyTheme(); });

  // ── 坐标变换 ──
  function i2s(px,py){ return {x:px*S.view.scale+S.view.ox, y:py*S.view.scale+S.view.oy}; }
  function s2i(sx,sy){ return {x:(sx-S.view.ox)/S.view.scale, y:(sy-S.view.oy)/S.view.scale}; }

  // ── 拖放：拖入文件夹/图片即打开该数据集 ──
  function pathFromDrop(dt){
    if(!dt)return '';
    try{ if(dt.files&&dt.files[0]&&dt.files[0].path) return dt.files[0].path; }catch(e){}
    try{ var u=dt.getData('text/uri-list')||''; u=u.split(/[\r\n]/)[0].trim();
      if(u.indexOf('file:')===0) return decodeURIComponent(u.replace(/^file:\/*/,'')).replace(/\//g,'\\'); }catch(e){}
    try{ var t=(dt.getData('text/plain')||dt.getData('text')||'').trim(); if(/^[a-zA-Z]:[\\\/]/.test(t)) return t; }catch(e){}
    return '';
  }
  function installDrop(){
    // 统一走 JadeView 原生 drag-drop → __jadeDrop（HTML 拖放拿不到真实路径）
    window.__jadeDrop=function(str){ try{
      var o=typeof str==='string'?JSON.parse(str):str, node=o, type='';
      ['type','action','event','kind','state'].some(function(k){ if(typeof o[k]==='string'){type=o[k].toLowerCase();return true;} });
      if(!type){ for(var k in o){ if(o[k]&&typeof o[k]==='object'){ type=k.toLowerCase(); node=o[k]; break; } } }
      if(type && type.indexOf('drop')<0) return;
      var paths=node.paths||node.files||node.data||o.paths||o.files||o.data||[];
      var p=(paths&&paths.length)?paths[0]:(node.path||o.path); if(!p)return;
      var dir=/\.[a-z0-9]{1,5}$/i.test(p)?String(p).replace(/[\\\/][^\\\/]*$/,''):String(p); openDir(dir);
    }catch(e){} };
  }
  // ── 初始化 ──
  function init(){
    applyTheme();
    cv=$('annCanvas'); host=$('annCanvasHost'); ctx=cv.getContext('2d');
    bindToolbar(); bindCanvas(); bindKeys(); installDrop();
    window.addEventListener('resize',function(){ resize(); draw(); });
    resize();
    // 读取初始目录（native 通过 ?dir= 传入）
    var q=new URLSearchParams(location.search); var dir=q.get('dir');
    if(dir){ openDir(dir); } else { setEmpty(true); }
  }

  function setEmpty(on){ $('annEmpty').style.display=on?'flex':'none'; }
  function resize(){
    var dpr=window.devicePixelRatio||1;
    var w=host.clientWidth, h=host.clientHeight;
    cv.width=w*dpr; cv.height=h*dpr; cv.style.width=w+'px'; cv.style.height=h+'px';
    ctx.setTransform(dpr,0,0,dpr,0,0);
  }

  // ── 打开目录 / 图片列表 ──
  function openDir(dir){
    status('加载文件夹…');
    try{ localStorage.setItem('yolo_mem_annotDir', dir); }catch(e){}   // 记忆，跨窗口共享
    invoke('yolo_list_images',{dir:dir}).then(function(res){
      if(!res||!res.ok){ status('打开失败：'+((res&&res.error)||'原生未就绪')); return; }
      S.dir=dir; S.images=res.images||[];
      renderImageList(); updateLabeledCount();
      // 载入 classes.txt
      loadClasses(function(){
        if(S.images.length){ loadImage(0); } else { setEmpty(true); status('文件夹内没有图片'); }
      });
    }).catch(function(){ status('原生未就绪，无法列出图片'); });
  }

  function loadClasses(done){
    invoke('yolo_read_text',{path:joinp(S.dir,'classes.txt')}).then(function(res){
      if(res&&res.ok&&res.text){ S.classes=res.text.split(/\r?\n/).map(function(s){return s.trim();}).filter(Boolean); }
      if(!S.classes.length) S.classes=['object'];
      renderClasses(); if(done)done();
    }).catch(function(){ if(!S.classes.length)S.classes=['object']; renderClasses(); if(done)done(); });
  }
  function saveClasses(){ invoke('yolo_write_text',{path:joinp(S.dir,'classes.txt'),text:S.classes.join('\n')+'\n'}).catch(function(){}); }

  // ── 载入某张图片 ──
  function loadImage(i){
    if(i<0||i>=S.images.length) return;
    if(S.dirty && S.autoSave && S.idx>=0) saveLabels(S.idx);
    S.idx=i; S.sel=-1; S.hover=-1; S.undo=[]; S.redo=[]; S.dirty=false;
    var im=S.images[i];
    $('annImgName').textContent=im.name+'  ('+(i+1)+'/'+S.images.length+')';
    status('加载图片…');
    invoke('yolo_read_image',{path:im.path}).then(function(res){
      if(!res||!res.ok){ status('图片读取失败'); return; }
      var img=new Image();
      img.onload=function(){
        S.img=img; S.imgW=res.w||img.width; S.imgH=res.h||img.height;
        setEmpty(false);
        loadLabels(im, function(){ fit(); draw(); renderBoxList(); renderImageList(); status('就绪'); });
      };
      img.src=res.data;
    }).catch(function(){ status('原生未就绪'); });
  }

  function loadLabels(im, done){
    invoke('yolo_read_text',{path:labelPath(im.path)}).then(function(res){
      S.boxes=[];
      if(res&&res.ok&&res.text){
        res.text.split(/\r?\n/).forEach(function(line){
          var p=line.trim().split(/\s+/); if(p.length<5)return;
          var c=parseInt(p[0],10), cx=+p[1],cy=+p[2],nw=+p[3],nh=+p[4];
          if(isNaN(cx))return;
          S.boxes.push({cls:c, x:(cx-nw/2)*S.imgW, y:(cy-nh/2)*S.imgH, w:nw*S.imgW, h:nh*S.imgH});
        });
      }
      if(done)done();
    }).catch(function(){ S.boxes=[]; if(done)done(); });
  }

  // ── 保存标注 ──
  function saveLabels(i){
    if(i==null)i=S.idx; if(i<0)return;
    var im=S.images[i];
    var lines=S.boxes.map(function(b){
      var cx=(b.x+b.w/2)/S.imgW, cy=(b.y+b.h/2)/S.imgH, nw=b.w/S.imgW, nh=b.h/S.imgH;
      return b.cls+' '+f6(cx)+' '+f6(cy)+' '+f6(nw)+' '+f6(nh);
    });
    invoke('yolo_write_text',{path:labelPath(im.path),text:lines.join('\n')+(lines.length?'\n':'')}).then(function(){
      S.dirty=false; im.count=S.boxes.length; im.hasLabel=S.boxes.length>0;
      renderImageList(); updateLabeledCount(); status('已保存 '+im.name);
    }).catch(function(){ status('保存失败（原生未就绪）'); });
    saveClasses();
  }
  function f6(v){ return (Math.round(v*1e6)/1e6).toString(); }

  // ── 视图 ──
  function fit(){
    if(!S.img)return;
    var w=host.clientWidth, h=host.clientHeight;
    var sc=Math.min(w/S.imgW, h/S.imgH)*0.96;
    S.view.scale=sc; S.view.ox=(w-S.imgW*sc)/2; S.view.oy=(h-S.imgH*sc)/2;
    updateZoom();
  }
  function zoomAt(sx,sy,factor){
    var before=s2i(sx,sy);
    S.view.scale=Math.max(0.02,Math.min(40,S.view.scale*factor));
    S.view.ox=sx-before.x*S.view.scale; S.view.oy=sy-before.y*S.view.scale;
    updateZoom(); draw();
  }
  function updateZoom(){ var z=$('annZoom'); if(z)z.textContent=Math.round(S.view.scale*100)+'%'; }

  // ── 绘制 ──
  function draw(){
    if(!ctx)return;
    ctx.clearRect(0,0,cv.width,cv.height);
    if(!S.img)return;
    var v=S.view;
    // 图片
    ctx.imageSmoothingEnabled = v.scale<3;
    ctx.drawImage(S.img, v.ox, v.oy, S.imgW*v.scale, S.imgH*v.scale);
    if(!S.showBoxes) return;
    // 框
    S.boxes.forEach(function(b,i){
      var p=i2s(b.x,b.y), col=clsColor(b.cls);
      var w=b.w*v.scale, h=b.h*v.scale;
      var selected=(i===S.sel), hovered=(i===S.hover);
      ctx.lineWidth=selected?2.5:(hovered?2:1.6); ctx.strokeStyle=col;
      ctx.fillStyle=col.replace(')',',0.12)').replace('rgb','rgba');
      // 半透明填充（hex → 用 globalAlpha）
      ctx.save(); ctx.globalAlpha=selected?0.16:(hovered?0.10:0.06); ctx.fillStyle=col; ctx.fillRect(p.x,p.y,w,h); ctx.restore();
      ctx.strokeRect(p.x,p.y,w,h);
      // 标签
      var name=(S.classes[b.cls]||('class '+b.cls));
      ctx.font='12px "Microsoft YaHei UI",sans-serif';
      var tw=ctx.measureText(name).width;
      ctx.fillStyle=col; ctx.fillRect(p.x-0.8, p.y-16, tw+10, 16);
      ctx.fillStyle='#fff'; ctx.fillText(name, p.x+4, p.y-4);
      // 选中：八个手柄
      if(selected){
        handleRects(b).forEach(function(hr){
          ctx.fillStyle='#fff'; ctx.strokeStyle=col; ctx.lineWidth=1.5;
          ctx.fillRect(hr.x-4,hr.y-4,8,8); ctx.strokeRect(hr.x-4,hr.y-4,8,8);
        });
      }
    });
    // 画框预览
    if(S.drag&&S.drag.mode==='new'&&S.drag.cur){
      var a=i2s(S.drag.x0,S.drag.y0), c=i2s(S.drag.cur.x,S.drag.cur.y);
      ctx.setLineDash([5,4]); ctx.lineWidth=1.6; ctx.strokeStyle=clsColor(S.curClass);
      ctx.strokeRect(Math.min(a.x,c.x),Math.min(a.y,c.y),Math.abs(c.x-a.x),Math.abs(c.y-a.y));
      ctx.setLineDash([]);
    }
    // 画框模式十字线
    if(S.tool==='draw'&&S.mouse&&!S.drag){
      ctx.strokeStyle='rgba(255,255,255,.35)'; ctx.lineWidth=1; ctx.setLineDash([4,4]);
      ctx.beginPath(); ctx.moveTo(S.mouse.x,0); ctx.lineTo(S.mouse.x,host.clientHeight);
      ctx.moveTo(0,S.mouse.y); ctx.lineTo(host.clientWidth,S.mouse.y); ctx.stroke(); ctx.setLineDash([]);
    }
  }

  function handleRects(b){
    var p=i2s(b.x,b.y), w=b.w*S.view.scale, h=b.h*S.view.scale;
    return [
      {k:'nw',x:p.x,y:p.y},{k:'n',x:p.x+w/2,y:p.y},{k:'ne',x:p.x+w,y:p.y},
      {k:'e',x:p.x+w,y:p.y+h/2},{k:'se',x:p.x+w,y:p.y+h},{k:'s',x:p.x+w/2,y:p.y+h},
      {k:'sw',x:p.x,y:p.y+h},{k:'w',x:p.x,y:p.y+h/2}
    ];
  }

  // ── 命中测试 ──
  function hitHandle(sx,sy){
    if(S.sel<0)return null;
    var hrs=handleRects(S.boxes[S.sel]);
    for(var i=0;i<hrs.length;i++){ if(Math.abs(sx-hrs[i].x)<6&&Math.abs(sy-hrs[i].y)<6)return hrs[i].k; }
    return null;
  }
  function hitBox(sx,sy){
    for(var i=S.boxes.length-1;i>=0;i--){
      var b=S.boxes[i], p=i2s(b.x,b.y), w=b.w*S.view.scale,h=b.h*S.view.scale;
      if(sx>=p.x&&sx<=p.x+w&&sy>=p.y&&sy<=p.y+h)return i;
    }
    return -1;
  }

  // ── 画布交互 ──
  function bindCanvas(){
    cv.addEventListener('mousedown',function(e){
      var r=cv.getBoundingClientRect(), sx=e.clientX-r.left, sy=e.clientY-r.top;
      if(e.button===1 || (e.button===0&&(e.ctrlKey||S.spaceDown))){ // 平移
        S.drag={mode:'pan',sx:sx,sy:sy,ox0:S.view.ox,oy0:S.view.oy}; e.preventDefault(); return;
      }
      if(e.button!==0)return;
      if(!S.img)return;
      if(S.tool==='draw'){
        var ip=s2i(sx,sy); S.drag={mode:'new',x0:ip.x,y0:ip.y,cur:ip}; return;
      }
      // select tool
      var h=hitHandle(sx,sy);
      if(h){ pushUndo(); var b=S.boxes[S.sel]; S.drag={mode:'resize',handle:h,ox:b.x,oy:b.y,ow:b.w,oh:b.h,sx:sx,sy:sy}; return; }
      var bi=hitBox(sx,sy);
      if(bi>=0){ S.sel=bi; pushUndo(); var bb=S.boxes[bi]; S.drag={mode:'move',ox:bb.x,oy:bb.y,sx:sx,sy:sy}; renderBoxList(); draw(); }
      else { S.sel=-1; renderBoxList(); draw(); }
    });
    window.addEventListener('mousemove',function(e){
      var r=cv.getBoundingClientRect(), sx=e.clientX-r.left, sy=e.clientY-r.top;
      S.mouse={x:sx,y:sy};
      if(S.img){ var ip=s2i(sx,sy); hud(Math.round(ip.x)+', '+Math.round(ip.y)); }
      if(!S.drag){
        if(S.tool==='select'){ var hh=hitHandle(sx,sy); cv.style.cursor=hh?curForHandle(hh):(hitBox(sx,sy)>=0?'move':'default'); }
        else cv.style.cursor='crosshair';
        var nh=(S.tool==='select')?hitBox(sx,sy):-1;
        if(nh!==S.hover){ S.hover=nh; draw(); } else if(S.tool==='draw'){ draw(); }
        return;
      }
      if(S.drag.mode==='pan'){ S.view.ox=S.drag.ox0+(sx-S.drag.sx); S.view.oy=S.drag.oy0+(sy-S.drag.sy); draw(); return; }
      if(S.drag.mode==='new'){ S.drag.cur=s2i(sx,sy); draw(); return; }
      var dx=(sx-S.drag.sx)/S.view.scale, dy=(sy-S.drag.sy)/S.view.scale, b=S.boxes[S.sel];
      if(S.drag.mode==='move'){ b.x=S.drag.ox+dx; b.y=S.drag.oy+dy; S.dirty=true; draw(); }
      else if(S.drag.mode==='resize'){ resizeBox(b,S.drag,dx,dy); S.dirty=true; draw(); renderBoxList(); }
    });
    window.addEventListener('mouseup',function(e){
      if(!S.drag)return;
      if(S.drag.mode==='new'&&S.drag.cur){
        var x=Math.min(S.drag.x0,S.drag.cur.x), y=Math.min(S.drag.y0,S.drag.cur.y);
        var w=Math.abs(S.drag.cur.x-S.drag.x0), h=Math.abs(S.drag.cur.y-S.drag.y0);
        if(w>3&&h>3){ pushUndo(); x=clamp(x,0,S.imgW); y=clamp(y,0,S.imgH);
          w=Math.min(w,S.imgW-x); h=Math.min(h,S.imgH-y);
          S.boxes.push({cls:S.curClass,x:x,y:y,w:w,h:h}); S.sel=S.boxes.length-1; S.dirty=true;
          renderBoxList(); renderImageList();
        }
      }
      if(S.drag.mode==='move'||S.drag.mode==='resize'){ normalizeBox(S.boxes[S.sel]); }
      S.drag=null; draw();
    });
    cv.addEventListener('wheel',function(e){
      e.preventDefault(); if(!S.img)return;
      var r=cv.getBoundingClientRect();
      zoomAt(e.clientX-r.left,e.clientY-r.top, e.deltaY<0?1.12:1/1.12);
    },{passive:false});
    cv.addEventListener('contextmenu',function(e){ e.preventDefault();
      var r=cv.getBoundingClientRect(); var bi=hitBox(e.clientX-r.left,e.clientY-r.top);
      if(bi>=0){ S.sel=bi; renderBoxList(); draw(); }
    });
  }
  function curForHandle(h){ return ({n:'ns-resize',s:'ns-resize',e:'ew-resize',w:'ew-resize',ne:'nesw-resize',sw:'nesw-resize',nw:'nwse-resize',se:'nwse-resize'})[h]||'default'; }
  function resizeBox(b,d,dx,dy){
    var x=d.ox,y=d.oy,w=d.ow,h=d.oh,H=d.handle;
    if(H.indexOf('w')>=0){ x=d.ox+dx; w=d.ow-dx; }
    if(H.indexOf('e')>=0){ w=d.ow+dx; }
    if(H.indexOf('n')>=0){ y=d.oy+dy; h=d.oh-dy; }
    if(H.indexOf('s')>=0){ h=d.oh+dy; }
    b.x=x;b.y=y;b.w=w;b.h=h;
  }
  function normalizeBox(b){ if(!b)return;
    if(b.w<0){b.x+=b.w;b.w=-b.w;} if(b.h<0){b.y+=b.h;b.h=-b.h;}
    b.x=clamp(b.x,0,S.imgW); b.y=clamp(b.y,0,S.imgH);
    b.w=Math.max(1,Math.min(b.w,S.imgW-b.x)); b.h=Math.max(1,Math.min(b.h,S.imgH-b.y));
  }
  function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }

  // ── 撤销/重做 ──
  function pushUndo(){ S.undo.push(JSON.stringify(S.boxes)); if(S.undo.length>60)S.undo.shift(); S.redo=[]; }
  function undo(){ if(!S.undo.length)return; S.redo.push(JSON.stringify(S.boxes)); S.boxes=JSON.parse(S.undo.pop()); S.sel=-1; S.dirty=true; draw(); renderBoxList(); renderImageList(); }
  function redo(){ if(!S.redo.length)return; S.undo.push(JSON.stringify(S.boxes)); S.boxes=JSON.parse(S.redo.pop()); S.sel=-1; S.dirty=true; draw(); renderBoxList(); renderImageList(); }

  // ── 键盘 ──
  function bindKeys(){
    window.addEventListener('keydown',function(e){
      if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA')return;
      var k=e.key;
      if(e.ctrlKey){
        if(k==='s'){ e.preventDefault(); saveLabels(); return; }
        if(k==='z'){ e.preventDefault(); undo(); return; }
        if(k==='y'){ e.preventDefault(); redo(); return; }
        return;
      }
      if(k===' '){ e.preventDefault(); nextImage(); return; }
      if(k==='w'||k==='W'){ setTool('draw'); }
      else if(k==='Escape'){ if(S.drag&&S.drag.mode==='new'){S.drag=null;draw();} else {setTool('select'); S.sel=-1; renderBoxList(); draw();} }
      else if(k==='Delete'||k==='Backspace'){ delSelected(); }
      else if(k==='a'||k==='A'||k==='ArrowLeft'){ e.preventDefault(); prevImage(); }
      else if(k==='d'||k==='D'||k==='ArrowRight'){ e.preventDefault(); nextImage(); }
      else if(k==='f'||k==='F'){ fit(); draw(); }
      else if(k==='h'||k==='H'){ S.showBoxes=!S.showBoxes; draw(); }
      else if(k>='1'&&k<='9'){ var idx=+k-1; if(idx<S.classes.length){ S.curClass=idx; if(S.sel>=0){pushUndo();S.boxes[S.sel].cls=idx;S.dirty=true;} renderClasses(); renderBoxList(); draw(); } }
    });
  }

  function delSelected(){ if(S.sel<0)return; pushUndo(); S.boxes.splice(S.sel,1); S.sel=-1; S.dirty=true; draw(); renderBoxList(); renderImageList(); }
  function setTool(t){ S.tool=t; Array.prototype.forEach.call(document.querySelectorAll('[data-tool]'),function(b){ b.classList.toggle('active',b.dataset.tool===t); }); cv.style.cursor=t==='draw'?'crosshair':'default'; draw(); }
  function nextImage(){ if(S.idx<S.images.length-1)loadImage(S.idx+1); }
  function prevImage(){ if(S.idx>0)loadImage(S.idx-1); }

  // ── 工具条 ──
  function bindToolbar(){
    Array.prototype.forEach.call(document.querySelectorAll('[data-tool]'),function(b){ b.addEventListener('click',function(){ setTool(b.dataset.tool); }); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-act]'),function(b){
      b.addEventListener('click',function(){ act(b.dataset.act); });
    });
    var as=$('annAutoSave'); if(as)as.addEventListener('change',function(){ S.autoSave=as.checked; });
    var add=$('annAddClass'); if(add)add.addEventListener('click',addClass);
    setTool('select');
  }
  function act(a){
    if(a==='save')saveLabels();
    else if(a==='fit'){ fit(); draw(); }
    else if(a==='zoomin'){ zoomAt(host.clientWidth/2,host.clientHeight/2,1.2); }
    else if(a==='zoomout'){ zoomAt(host.clientWidth/2,host.clientHeight/2,1/1.2); }
    else if(a==='hide'){ S.showBoxes=!S.showBoxes; draw(); }
    else if(a==='undo')undo(); else if(a==='redo')redo();
    else if(a==='opendir'){ invoke('yolo_pick_dir',{}).then(function(res){ if(res&&res.ok&&res.path)openDir(res.path); }).catch(function(){ status('原生未就绪'); }); }
  }

  // ── 类别面板 ──
  function renderClasses(){
    $('annClsCount').textContent=S.classes.length;
    $('annClassList').innerHTML=S.classes.map(function(c,i){
      return '<div class="ann-class'+(i===S.curClass?' active':'')+'" data-cls="'+i+'">'+
        '<span class="ann-cls-dot" style="background:'+clsColor(i)+'"></span>'+
        '<span class="ann-cls-key">'+(i<9?(i+1):'')+'</span>'+
        '<span class="ann-cls-name" data-clsname="'+i+'">'+esc(c)+'</span>'+
        '<button class="ann-cls-del" data-clsdel="'+i+'" title="删除类别">×</button></div>';
    }).join('');
    Array.prototype.forEach.call(document.querySelectorAll('[data-cls]'),function(el){
      el.addEventListener('click',function(e){ if(e.target.dataset.clsdel!=null||e.target.dataset.clsname!=null)return;
        S.curClass=+el.dataset.cls; renderClasses(); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-clsname]'),function(el){
      el.addEventListener('dblclick',function(){ renameClass(+el.dataset.clsname); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-clsdel]'),function(el){
      el.addEventListener('click',function(e){ e.stopPropagation(); delClass(+el.dataset.clsdel); });
    });
  }
  function addClass(){ annPrompt('新增类别','类别名称','').then(function(name){ if(name==null)return; S.classes.push(name||('class'+S.classes.length)); S.curClass=S.classes.length-1; saveClasses(); renderClasses(); }); }
  function renameClass(i){ annPrompt('重命名类别','类别名称',S.classes[i]).then(function(name){ if(name==null||name==='')return; S.classes[i]=name; saveClasses(); renderClasses(); renderBoxList(); draw(); }); }
  function delClass(i){
    if(S.classes.length<=1){ status('至少保留一个类别'); return; }
    annConfirm('删除类别 “'+S.classes[i]+'”？使用该类别的框会一并删除。').then(function(ok){ if(!ok)return;
      pushUndo();
      S.boxes=S.boxes.filter(function(b){return b.cls!==i;});
      S.boxes.forEach(function(b){ if(b.cls>i)b.cls--; });
      S.classes.splice(i,1); if(S.curClass>=S.classes.length)S.curClass=S.classes.length-1;
      S.dirty=true; saveClasses(); renderClasses(); renderBoxList(); renderImageList(); draw();
    });
  }

  // ── 目标列表 ──
  function renderBoxList(){
    $('annBoxCount').textContent=S.boxes.length;
    $('annBoxList').innerHTML=S.boxes.map(function(b,i){
      return '<div class="ann-boxrow'+(i===S.sel?' active':'')+'" data-box="'+i+'">'+
        '<span class="ann-cls-dot" style="background:'+clsColor(b.cls)+'"></span>'+
        '<select class="ann-box-cls" data-boxcls="'+i+'">'+S.classes.map(function(c,ci){return '<option value="'+ci+'"'+(ci===b.cls?' selected':'')+'>'+esc(c)+'</option>';}).join('')+'</select>'+
        '<span class="ann-box-sz">'+Math.round(b.w)+'×'+Math.round(b.h)+'</span>'+
        '<button class="ann-cls-del" data-boxdel="'+i+'">×</button></div>';
    }).join('');
    Array.prototype.forEach.call(document.querySelectorAll('[data-box]'),function(el){
      el.addEventListener('click',function(e){ if(e.target.dataset.boxdel!=null||e.target.dataset.boxcls!=null)return; S.sel=+el.dataset.box; renderBoxList(); draw(); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-boxcls]'),function(sel){
      sel.addEventListener('change',function(){ pushUndo(); S.boxes[+sel.dataset.boxcls].cls=+sel.value; S.dirty=true; draw(); renderBoxList(); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-boxdel]'),function(el){
      el.addEventListener('click',function(e){ e.stopPropagation(); pushUndo(); S.boxes.splice(+el.dataset.boxdel,1); S.sel=-1; S.dirty=true; draw(); renderBoxList(); renderImageList(); });
    });
  }

  // ── 图片列表 ──
  function renderImageList(){
    $('annImgCount').textContent=S.images.length;
    var cur = S.idx>=0?S.images[S.idx]:null;
    if(cur){ cur.count=S.boxes.length; cur.hasLabel=S.boxes.length>0; }
    $('annImageList').innerHTML=S.images.map(function(im,i){
      return '<div class="ann-imgrow'+(i===S.idx?' active':'')+'" data-img="'+i+'">'+
        '<span class="ann-img-dot'+(im.hasLabel?' on':'')+'"></span>'+
        '<span class="ann-img-name" title="'+esc(im.name)+'">'+esc(im.name)+'</span>'+
        '<span class="ann-img-cnt">'+(im.count||0)+'</span></div>';
    }).join('');
    Array.prototype.forEach.call(document.querySelectorAll('[data-img]'),function(el){
      el.addEventListener('click',function(){ loadImage(+el.dataset.img); });
    });
    var act=document.querySelector('.ann-imgrow.active'); if(act)act.scrollIntoView({block:'nearest'});
  }
  function updateLabeledCount(){ var n=S.images.filter(function(im){return im.hasLabel;}).length; $('annLabeledCount').textContent=n+' 已标'; }

  // ── HUD / 状态栏 ──
  function hud(t){ var h=$('annHud'); if(h)h.textContent=t; }
  function status(t){ var l=$('annStatusLeft'); if(l)l.textContent=t; var r=$('annStatusRight'); if(r)r.textContent=(S.tool==='draw'?'画框模式':'选择模式')+(S.dirty?' · 未保存':''); }

  // ── 路径工具 ──
  function joinp(dir,f){ return dir.replace(/[\\\/]+$/,'')+'\\'+f; }
  function labelPath(imgPath){ return imgPath.replace(/\.[^.\\\/]+$/,'')+'.txt'; }

  // ── 迷你对话框 ──
  function annPrompt(title,ph,def){
    return new Promise(function(resolve){
      var m=document.createElement('div'); m.className='ann-modal-mask';
      m.innerHTML='<div class="ann-modal"><div class="ann-modal-title">'+esc(title)+'</div>'+
        '<input class="ann-modal-input" value="'+esc(def||'')+'" placeholder="'+esc(ph||'')+'">'+
        '<div class="ann-modal-btns"><button class="ann-tool" data-mc>取消</button><button class="ann-tool primary" data-mo>确定</button></div></div>';
      document.body.appendChild(m);
      var inp=m.querySelector('.ann-modal-input'); inp.focus(); inp.select();
      function close(v){ m.remove(); resolve(v); }
      m.querySelector('[data-mo]').onclick=function(){ close(inp.value.trim()); };
      m.querySelector('[data-mc]').onclick=function(){ close(null); };
      inp.onkeydown=function(e){ if(e.key==='Enter')close(inp.value.trim()); if(e.key==='Escape')close(null); };
    });
  }
  function annConfirm(msg){
    return new Promise(function(resolve){
      var m=document.createElement('div'); m.className='ann-modal-mask';
      m.innerHTML='<div class="ann-modal"><div class="ann-modal-msg">'+esc(msg)+'</div>'+
        '<div class="ann-modal-btns"><button class="ann-tool" data-mc>取消</button><button class="ann-tool primary" data-mo>确定</button></div></div>';
      document.body.appendChild(m);
      function close(v){ m.remove(); resolve(v); }
      m.querySelector('[data-mo]').onclick=function(){ close(true); };
      m.querySelector('[data-mc]').onclick=function(){ close(false); };
    });
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init); else init();
})();
