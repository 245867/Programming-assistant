// ═══════════════════════════════════════════════════════════
//  YOLO 工具  —  训练 / 标注 / 推理  (YOLOv5)
//  纯前端交互层，重活通过 JADE.invoke 调 main.cpp 原生：
//    yolo_pick_file / yolo_pick_dir / yolo_read_image
//    yolo_train_start / yolo_train_poll / yolo_train_stop
//    yolo_infer / yolo_open_annotator / yolo_env_detect
//  三套主题(glass/black/white)全靠 style.css 的 CSS 变量自动适配。
// ═══════════════════════════════════════════════════════════
(function () {
  'use strict';
  var $ = JADE.$, esc = JADE.esc, invoke = JADE.invoke;

  // 检测框调色板（16 色，循环）
  var PALETTE = ['#ef4444','#3b82f6','#22c55e','#f59e0b','#a855f7','#06b6d4',
    '#ec4899','#84cc16','#f97316','#14b8a6','#6366f1','#eab308',
    '#f43f5e','#0ea5e9','#10b981','#d946ef'];
  function clsColor(i){ return PALETTE[((i%PALETTE.length)+PALETTE.length)%PALETTE.length]; }

  // ── 训练参数 schema：分组 · 中英文名 · 功能描述 · 默认值 ─────────────
  //  hyp:true 的参数会被写进临时 hyp.yaml 用 --hyp 传入；其余是 train.py 命令行参数
  var TRAIN_GROUPS = [
    { title:'训练控制', en:'Training Control', icon:'⚙️', params:[
      { k:'epochs', zh:'训练轮数', en:'epochs', type:'int', def:100, min:1,
        desc:'整个数据集被完整训练的次数。越大越充分但耗时越长，配合早停避免过拟合。' },
      { k:'batch', zh:'批大小', en:'batch', type:'int', def:16, min:1,
        desc:'一次前向/反向所用图片数。越大越稳但更吃显存。' },
      { k:'subdivisions', zh:'批切分', en:'subdivisions', type:'int', def:1, min:1,
        desc:'把一批再切成几份依次送入。显存不够时调大，可降低单次显存占用（速度略降）。' },
      { k:'imgsz', zh:'输入尺寸', en:'imgsz', type:'int', def:640, step:32,
        desc:'训练输入的图像边长(像素)，需为 32 的倍数。越大小目标越清晰但更慢更吃显存。' },
      { k:'optimizer', zh:'优化器', en:'optimizer', type:'select', def:'SGD', opts:['SGD','Adam','AdamW'],
        desc:'参数更新算法。SGD 泛化好；Adam/AdamW 收敛快、对学习率不敏感。' },
      { k:'patience', zh:'早停耐心', en:'patience', type:'int', def:100, min:0,
        desc:'验证指标连续多少轮无提升就提前停止。设很大(如1000)可关闭早停。' },
    ]},
    { title:'优化器超参', en:'Optimizer Hyp', icon:'📉', hyp:true, params:[
      { k:'lr0', zh:'初始学习率', en:'lr0', type:'float', def:0.01,
        desc:'起始学习率。SGD 常用 0.01，Adam 常用 0.001。过大发散、过小收敛慢。' },
      { k:'lrf', zh:'最终学习率比', en:'lrf', type:'float', def:0.01,
        desc:'训练结束时学习率 = lr0 × lrf。控制衰减到多低。' },
      { k:'momentum', zh:'动量', en:'momentum', type:'float', def:0.937,
        desc:'SGD 动量 / Adam 的 beta1。加速收敛并抑制震荡，一般 0.9~0.95。' },
      { k:'weight_decay', zh:'权重衰减', en:'weight_decay', type:'float', def:0.0005,
        desc:'L2 正则强度，抑制过拟合。过大欠拟合，过小易过拟合。' },
      { k:'warmup_epochs', zh:'热身轮数', en:'warmup_epochs', type:'float', def:3.0,
        desc:'开头若干轮把学习率从很小线性升到 lr0，稳定早期训练。' },
      { k:'label_smoothing', zh:'标签平滑', en:'label_smoothing', type:'float', def:0.0, cmd:true,
        desc:'把硬标签软化(如 0.1)，缓解过度自信、提升泛化。' },
    ]},
    { title:'损失权重', en:'Loss Gains', icon:'⚖️', hyp:true, params:[
      { k:'box', zh:'定位损失权重', en:'box', type:'float', def:0.05,
        desc:'边框回归(位置/大小)在总损失中的权重。调大更重视框的准确度。' },
      { k:'cls', zh:'分类损失权重', en:'cls', type:'float', def:0.5,
        desc:'类别分类损失权重。类别多或易混时可适当调大。' },
      { k:'obj', zh:'置信度损失权重', en:'obj', type:'float', def:1.0,
        desc:'有无目标(objectness)损失权重。影响召回与误检的平衡。' },
      { k:'iou_t', zh:'IoU 训练阈值', en:'iou_t', type:'float', def:0.20,
        desc:'正样本匹配的 IoU 门槛，决定哪些预测框参与回归。' },
      { k:'anchor_t', zh:'锚框倍率阈值', en:'anchor_t', type:'float', def:4.0,
        desc:'目标与锚框宽高比超过该倍数则忽略。影响自动锚框(AutoAnchor)。' },
      { k:'fl_gamma', zh:'Focal 系数', en:'fl_gamma', type:'float', def:0.0,
        desc:'Focal Loss 的 γ，>0 时更关注难样本、缓解类别不平衡。0 关闭。' },
    ]},
    { title:'数据增强', en:'Augmentation', icon:'🎨', hyp:true, params:[
      { k:'hsv_h', zh:'色调抖动', en:'hsv_h', type:'float', def:0.015,
        desc:'HSV 色相随机偏移幅度(比例)。增强对颜色变化的鲁棒性。' },
      { k:'hsv_s', zh:'饱和度抖动', en:'hsv_s', type:'float', def:0.7,
        desc:'HSV 饱和度随机缩放幅度。' },
      { k:'hsv_v', zh:'明度抖动', en:'hsv_v', type:'float', def:0.4,
        desc:'HSV 明度(亮度)随机缩放幅度，应对光照变化。' },
      { k:'degrees', zh:'旋转角度', en:'degrees', type:'float', def:0.0,
        desc:'随机旋转 ±角度(度)。目标方向多变时可调大。' },
      { k:'translate', zh:'平移比例', en:'translate', type:'float', def:0.1,
        desc:'随机平移幅度(占图像比例)。' },
      { k:'scale', zh:'缩放比例', en:'scale', type:'float', def:0.5,
        desc:'随机缩放幅度(±比例)。增强多尺度适应。' },
      { k:'shear', zh:'错切', en:'shear', type:'float', def:0.0,
        desc:'随机错切(倾斜)±角度。' },
      { k:'perspective', zh:'透视', en:'perspective', type:'float', def:0.0,
        desc:'随机透视变换幅度(0~0.001)，模拟视角变化。' },
      { k:'flipud', zh:'上下翻转', en:'flipud', type:'float', def:0.0,
        desc:'上下翻转概率。俯拍/无方向性目标可开(0.5)。' },
      { k:'fliplr', zh:'左右翻转', en:'fliplr', type:'float', def:0.5,
        desc:'左右翻转概率。最常用增强，默认 0.5。' },
      { k:'mosaic', zh:'马赛克拼图', en:'mosaic', type:'float', def:1.0,
        desc:'四图拼接增强的概率。极大丰富小目标与上下文，默认开(1.0)。' },
      { k:'mixup', zh:'混合叠加', en:'mixup', type:'float', def:0.0,
        desc:'两图按透明度叠加的概率。大数据集上可小幅提升。' },
      { k:'copy_paste', zh:'复制粘贴', en:'copy_paste', type:'float', def:0.0,
        desc:'分割目标复制粘贴增强概率(需分割标签)。' },
    ]},
  ];

  // schema 扁平索引
  var PARAM_INDEX = {};
  TRAIN_GROUPS.forEach(function(g){ g.params.forEach(function(p){ p._group=g; PARAM_INDEX[p.k]=p; }); });

  function defaultTrain(){
    var t={};
    TRAIN_GROUPS.forEach(function(g){ g.params.forEach(function(p){ t[p.k]=p.def; }); });
    return t;
  }

  // 通过 ultralytics 一个包支持 v8/v11/v9/v10/v5u；经典 v5 走 yolov5 仓库
  var VERSIONS=[
    { v:'yolov8', label:'YOLOv8', backend:'ultra', models:['yolov8n.pt','yolov8s.pt','yolov8m.pt','yolov8l.pt','yolov8x.pt'], d:'Ultralytics 主力，成熟稳定、生态最全（推荐）' },
    { v:'yolo11', label:'YOLO11', backend:'ultra', models:['yolo11n.pt','yolo11s.pt','yolo11m.pt','yolo11l.pt','yolo11x.pt'], d:'较新一代，同规模下精度/速度更优' },
    { v:'yolov9', label:'YOLOv9', backend:'ultra', models:['yolov9t.pt','yolov9s.pt','yolov9m.pt','yolov9c.pt','yolov9e.pt'], d:'PGI/GELAN 结构，精度强' },
    { v:'yolov10', label:'YOLOv10', backend:'ultra', models:['yolov10n.pt','yolov10s.pt','yolov10m.pt','yolov10b.pt','yolov10x.pt'], d:'端到端无 NMS，推理更快' },
    { v:'yolov5u', label:'YOLOv5u', backend:'ultra', models:['yolov5nu.pt','yolov5su.pt','yolov5mu.pt','yolov5lu.pt','yolov5xu.pt'], d:'v5 骨干 + 无锚框头（Ultralytics 版 v5）' },
    { v:'yolov5', label:'YOLOv5 经典', backend:'yolov5', models:['yolov5n.pt','yolov5s.pt','yolov5m.pt','yolov5l.pt','yolov5x.pt'], d:'原版 anchor v5，走你本机的 yolov5 仓库 train.py' }
  ];
  function verOf(v){ return VERSIONS.filter(function(x){return x.v===v;})[0]||VERSIONS[0]; }

  // ── 路径记忆（所有拖放/选择处记住上次值，下次预填）──
  function recall(k,def){ try{ var v=localStorage.getItem('yolo_mem_'+k); return (v==null||v==='')?(def||''):v; }catch(e){ return def||''; } }
  function remember(k,v){ try{ if(v!=null&&v!=='') localStorage.setItem('yolo_mem_'+k, v); }catch(e){} }

  function defaultData(){
    var ver=recall('ver','yolov5');
    return {
      sub:'train',
      py:{ path:recall('pyPath'), list:[], detected:false, torch:false, ultra:false, cuda:false, gpu:'', tver:'', uver:'', checked:false },
      ver:ver, model:recall('model_'+ver, verOf(ver).models[1]||verOf(ver).models[0]), dataset:recall('dataset'), yolov5dir:recall('yolov5dir'), project:'', paramsOpen:false,
      train: defaultTrain(),
      showRawLog:false,
      run:{ status:'idle', epoch:0, total:0, log:'', csv:[], startTs:0, epochTs:[], msg:'' },
      infer:{ model:recall('inferModel'), source:recall('inferSource'), imgW:0, imgH:0, imgData:'', dets:[], names:[], conf:0.8, iou:0.45, status:'idle', msg:'' },
      annot:{ lastDir:recall('annotDir') },
      cnn:{ dataset:recall('cnnDataset'), imgW:0, imgH:0, charset:'', maxLen:6, count:0, sample:'', status:'idle', msg:'' }
    };
  }

  // ════════════════ 文件/文件夹拖放 → 路径输入 ════════════════
  //  WebView2 里 HTML 拖放默认拿不到真实路径；这里尽力从 File.path / text/uri-list / 纯文本 提取。
  //  若都取不到（宿主没暴露），需改走原生 drag-drop 事件（见 window.__jadeDrop 兜底）。
  function pathFromDrop(dt){
    if(!dt) return '';
    try{ if(dt.files&&dt.files[0]&&dt.files[0].path) return dt.files[0].path; }catch(e){}
    try{ var u=dt.getData('text/uri-list')||''; u=u.split(/[\r\n]/)[0].trim();
      if(u.indexOf('file:')===0) return decodeURIComponent(u.replace(/^file:\/*/,'')).replace(/\//g,'\\'); }catch(e){}
    try{ var t=(dt.getData('text/plain')||dt.getData('text')||'').trim();
      if(/^[a-zA-Z]:[\\\/]/.test(t)||/^\\\\/.test(t)) return t; }catch(e){}
    return '';
  }
  function isPathInput(el){ return el&&el.tagName==='INPUT'&&/\byolo-input\b/.test(el.className||'')&&el.type!=='number'&&el.type!=='checkbox'&&el.type!=='range'; }
  function setDroppedPath(inp, path){
    inp.value=path;
    inp.dispatchEvent(new Event('input',{bubbles:true}));
    inp.dispatchEvent(new Event('change',{bubbles:true}));
    inp.classList.remove('yolo-dragover');
    if(inp.id==='yoloInferSrc'){ var ap=window.activePage&&window.activePage(); if(ap)loadPreview(ap,path); }
  }
  var _dropInstalled=false;
  function installDrop(){
    if(_dropInstalled)return; _dropInstalled=true;
    // WebView2 里 HTML 拖放拿不到真实路径，统一走 JadeView 原生 drag-drop → __jadeDrop
    window.__jadeDrop=function(str){
      try{
        var o=typeof str==='string'?JSON.parse(str):str, node=o, type='';
        ['type','action','event','kind','state'].some(function(k){ if(typeof o[k]==='string'){type=o[k].toLowerCase();return true;} });
        if(!type){ for(var k in o){ if(o[k]&&typeof o[k]==='object'){ type=k.toLowerCase(); node=o[k]; break; } } }
        if(type && type.indexOf('drop')<0) return;          // enter/over/leave 忽略
        var paths=node.paths||node.files||node.data||o.paths||o.files||o.data||[];
        var path=(paths&&paths.length)?paths[0]:(node.path||o.path); if(!path)return;
        var pos=node.position||o.position||{x:(node.x!=null?node.x:o.x),y:(node.y!=null?node.y:o.y)};
        var dpr=window.devicePixelRatio||1;
        var x=(pos&&pos.x!=null)?pos.x/dpr:null, y=(pos&&pos.y!=null)?pos.y/dpr:null;
        var el=(x!=null&&y!=null)?document.elementFromPoint(x,y):document.activeElement;
        // 拖到大图预览框 → 当作图片源
        if(el&&el.closest&&el.closest('.yolo-canvas-wrap')){ var si=$('yoloInferSrc'); if(si){ setDroppedPath(si,String(path)); return; } }
        var inp=isPathInput(el)?el:(el&&el.closest?el.closest('.yolo-io-field,.yolo-path,.yolo-py-row'):null);
        if(inp&&!isPathInput(inp))inp=inp.querySelector('input.yolo-input');
        if(isPathInput(inp))setDroppedPath(inp,String(path));
      }catch(e){}
    };
  }

  // ════════════════ 顶层渲染 ════════════════
  function render(page){
    installDrop();
    var d=page.data;
    if(!d.train){ Object.assign(d, defaultData()); }
    if(!d.cnn){ d.cnn={ dataset:'', imgW:0, imgH:0, charset:'', maxLen:6, count:0, sample:'', status:'idle', msg:'' }; }
    // Keep the two inference paths durable even when the value was supplied by a picker or drag/drop.
    if(d.infer){ remember('inferModel',d.infer.model); remember('inferSource',d.infer.source); }
    var subs=[['train','训练','Train'],['annot','标注','Annotate'],['infer','推理','Detect'],['cnn','CNN识别','Text CNN']];
    var seg=subs.map(function(s){
      return '<button class="yolo-seg'+(d.sub===s[0]?' active':'')+'" data-sub="'+s[0]+'">'+
        '<span class="yolo-seg-zh">'+s[1]+'</span><span class="yolo-seg-en">'+s[2]+'</span></button>';
    }).join('');
    var body = d.sub==='train'? (d.paramsOpen?paramsHtml(page):trainHtml(page))
             : d.sub==='infer'? inferHtml(page)
             : d.sub==='cnn'? cnnHtml(page)
             : annotHtml(page);
    var trainMeta='';
    if(d.sub==='train'){
      var device=d.py&&d.py.cuda?('GPU · '+esc(d.py.gpu||'NVIDIA')):'自动选择 GPU / CPU';
      trainMeta='<div class="yolo-train-meta"><span>⚡ Python + Ultralytics</span><span>'+device+'</span><span>YOLOv5 / v8 / v9 / v10 / v11</span></div>';
    }
    var html =
      '<div class="hero-card yolo-hero">'+
        '<div class="yolo-hero-copy"><h1 class="page-title">YOLO 工具 <span class="yolo-badge">检测 · CNN</span></h1>'+
        '<p class="page-desc">目标检测训练 · 标注 · 推理 · 文字识别　一体化工作台</p></div>'+
        '<div class="yolo-hero-side"><div class="yolo-seg-group">'+seg+'</div></div>'+trainMeta+ 
      '</div>'+
      '<div class="yolo-body" id="yoloBody">'+body+'</div>';
    $('page').innerHTML=html;
    $('page').classList.toggle('yolo-page',d.sub==='infer');
    var sub=$('activeSubtitle'); if(sub)sub.textContent='YOLO · 检测/标注/推理/CNN识别';
    bindTop(page);
    if(d.sub==='train'){ d.paramsOpen?bindParams(page):bindTrain(page); }
    else if(d.sub==='infer'){ bindInfer(page); requestAnimationFrame(function(){drawDetections(page);}); }
    else if(d.sub==='cnn'){ bindCnn(page); }
    else { bindAnnot(page); }
  }

  function bindTop(page){
    var d=page.data;
    Array.prototype.forEach.call(document.querySelectorAll('.yolo-seg'),function(b){
      b.addEventListener('click',function(){ if(d.sub!==b.dataset.sub){ d.sub=b.dataset.sub; d.paramsOpen=false; render(page); } });
    });
  }

  // ════════════════ 训练面板（主视图，紧凑）════════════════
  function pyRowHtml(page){
    var p=page.data.py;
    var opts=(p.list||[]).map(function(x){return '<option value="'+esc(x.path)+'"'+(p.path===x.path?' selected':'')+'>'+esc(x.version||'Python')+'　'+esc(x.path)+'</option>';}).join('');
    return '<div class="yolo-py-row">'+
      (opts?('<select class="yolo-input" id="yoloPyPick" style="flex:1">'+opts+'</select>')
           :('<input class="yolo-input" id="yoloPyPath" style="flex:1" value="'+esc(p.path)+'" placeholder="Python 解释器：点“检测”自动查找，或手填 python.exe 路径">'))+
      '<button class="yolo-btn primary sm" id="yoloPyDetect">🔍 检测</button>'+
      '<button class="yolo-btn ghost sm" id="yoloPyManual">手填路径</button>'+
      '<button class="yolo-btn ghost sm" id="yoloEnvBtn">🩺 环境检测</button>'+
    '</div>';
  }
  // 依赖状态徽章 + 当前模式大徽标 + 安装（放在控制行）
  function depsHtml(page){
    var p=page.data.py; if(!p.checked) return '';
    var ins=page.data.installing;
    var badge=function(on,txt,ver){ return '<span class="yolo-dep '+(on?'ok':'no')+'">'+(on?'✓':'✗')+' '+txt+(on&&ver?(' '+ver):'')+'</span>'; };
    var cpuTorch = p.torch && /cpu/i.test(p.tver||'');
    // 醒目的当前模式
    var mode = p.cuda
      ? '<span class="yolo-mode gpu">⚡ 当前：GPU 加速 · '+esc(p.gpu||'NVIDIA')+'</span>'
      : (p.torch ? '<span class="yolo-mode cpu">🐢 当前：CPU 模式'+(cpuTorch?'（PyTorch 是 CPU 版）':'（无可用 CUDA GPU）')+'</span>' : '');
    var cudaBadge = p.cuda
      ? '<span class="yolo-dep ok">✓ CUDA · '+esc(p.gpu||'GPU')+'</span>'
      : '<span class="yolo-dep no">✗ CUDA'+(cpuTorch?'（torch 为 CPU 版）':'（无可用 GPU）')+'</span>';
    var installBtn = (!p.ultra||!p.torch)
      ? ('<button class="yolo-btn primary sm" id="yoloDepInstall"'+(ins?' disabled':'')+'>'+(ins?'<span class="yolo-spin"></span>安装中…':'一键安装依赖')+'</button>') : '';
    var gpuBtn = (p.torch && !p.cuda)
      ? ('<button class="yolo-btn ghost sm" id="yoloGpuInstall"'+(ins?' disabled':'')+' title="安装 CUDA 版 PyTorch(约2.5GB)以启用 GPU">'+(ins?'<span class="yolo-spin"></span>安装中…':'↑ 改用 GPU 版')+'</button>') : '';
    var repairBtn = '<button class="yolo-btn ghost sm" id="yoloDepRepair"'+(ins?' disabled':'')+' title="清理损坏的安装（如中断留下的 ~orch）并强制重装干净 torch+ultralytics">🔧 修复依赖</button>';
    return mode+ badge(p.torch,'PyTorch',p.tver)+ badge(p.ultra,'ultralytics',p.uver)+ cudaBadge+ installBtn+ gpuBtn+ repairBtn;
  }
  function trainHtml(page){
    var d=page.data, r=d.run;
    var running = r.status==='running';
    var installing = !!d.installing;
    var cur=verOf(d.ver), isV5=cur.backend==='yolov5';
    var verOpts=VERSIONS.map(function(v){return '<option value="'+v.v+'"'+(d.ver===v.v?' selected':'')+'>'+esc(v.label)+'</option>';}).join('');
    var modelOpts=cur.models.map(function(m){return '<option value="'+m+'"'+(d.model===m?' selected':'')+'>'+esc(m)+'</option>';}).join('');
    // 一行控制条：依赖徽章 + 一键安装 + 训练参数 + 开始训练/查看命令/原始日志
    var startBtn = running
      ? '<button class="yolo-btn danger sm" id="yoloTrainStop"><span class="yolo-spin"></span>停止训练</button>'
      : '<button class="yolo-btn primary sm" id="yoloTrainStart"'+(installing?' disabled':'')+'>▶ 开始训练</button>';
    var ctrlRow =
      '<div class="yolo-deps yolo-ctrl">'+
        depsHtml(page)+
        '<button class="yolo-btn ghost sm" id="yoloOpenParamsBtn">⚙ 训练参数</button>'+
        '<span class="yolo-ctrl-gap"></span>'+
        startBtn+
        '<button class="yolo-btn ghost sm" id="yoloCfgPreview2">查看命令</button>'+
        '<label class="yolo-switch"><input type="checkbox" id="yoloRawToggle"'+(d.showRawLog?' checked':'')+'><span class="yolo-switch-track"></span>原始日志</label>'+
        '<span class="yolo-arch-desc-inline">'+esc(cur.d)+'</span>'+
      '</div>';

    var banner = installing
      ? '<div class="yolo-installing"><span class="yolo-spin"></span> 正在下载/安装依赖——<b>无需操作，请耐心、勿关闭</b>'+
        '<div class="yolo-inst-barwrap indet"><div class="yolo-inst-fill" id="yoloInstFill" style="width:100%"></div></div>'+
        '<span class="yolo-inst-prog" id="yoloInstProg"></span></div>'
      : '';
    var setup =
      banner+
      pyRowHtml(page)+
      ctrlRow+
      '<div class="yolo-ds-row">'+
        '<label class="yolo-arch">YOLO 版本<select class="yolo-input" id="yoloVer">'+verOpts+'</select></label>'+
        '<label class="yolo-arch">模型<select class="yolo-input" id="yoloModel">'+modelOpts+'</select></label>'+
        '<div class="yolo-io-field" style="flex:2"><span>数据集配置 data.yaml（定义 train/val/类别）</span>'+
          '<input class="yolo-input" id="yoloDataset" value="'+esc(d.dataset)+'" placeholder="选择 data.yaml"><button class="yolo-pick" data-dspick="1" data-pick="file">…</button></div>'+
      '</div>'+
      (isV5?('<div class="yolo-ds-row"><div class="yolo-io-field" style="flex:1"><span>yolov5 仓库目录（含 train.py）</span>'+
        '<input class="yolo-input" id="yoloV5Dir" value="'+esc(d.yolov5dir)+'" placeholder="如 D:\\yolo\\yolov5-7.0"><button class="yolo-pick" data-v5pick="1" data-pick="dir">…</button></div></div>'):'');

    // 进度卡仅在训练开始后出现；空闲/装依赖时不占地方
    return '<div class="yolo-train">'+
      setup+ (r.status!=='idle' ? trainProgressHtml(page) : '')+
      '<div class="yolo-rawlog'+(d.showRawLog?' show':'')+'" id="yoloRawLog"><pre id="yoloRawLogPre">'+esc(r.log||(installing?'安装依赖中…':'（训练/安装输出会显示在这里）'))+'</pre></div>'+
    '</div>';
  }

  // 训练参数（单独页）
  function paramsHtml(page){
    var t=page.data.train;
    var groups = TRAIN_GROUPS.map(function(g){
      var rows = g.params.map(function(p){ return paramRow(p, t[p.k]); }).join('');
      return '<details class="yolo-group" open>'+
        '<summary><span class="yolo-grp-ico">'+g.icon+'</span>'+g.title+
        ' <span class="yolo-grp-en">'+g.en+'</span>'+
        '<span class="yolo-grp-count">'+g.params.length+' 项</span></summary>'+
        '<div class="yolo-grid">'+rows+'</div></details>';
    }).join('');
    return '<div class="yolo-params-page">'+
      '<div class="yolo-params-bar">'+
        '<button class="yolo-btn primary" id="yoloParamsBack">← 返回训练</button>'+
        '<span class="yolo-params-title">训练参数</span>'+
        '<div class="yolo-params-bar-right">'+
          '<button class="yolo-btn ghost sm" id="yoloCfgPreview">配置预览</button>'+
          '<button class="yolo-btn ghost sm" id="yoloResetParams">恢复默认</button>'+
        '</div>'+
      '</div>'+
      '<div class="yolo-params">'+groups+'</div>'+
    '</div>';
  }

  function paramRow(p, val){
    var label='<div class="yolo-plabel"><span class="yolo-pzh">'+p.zh+'</span>'+
      '<span class="yolo-pen">'+p.en+'</span>'+
      '<span class="yolo-phelp" data-help="'+esc(p.desc)+'">?</span></div>';
    var input;
    if(p.type==='bool'){
      input='<label class="yolo-switch mini"><input type="checkbox" data-param="'+p.k+'"'+(val?' checked':'')+'><span class="yolo-switch-track"></span></label>';
    } else if(p.type==='select'){
      input='<select class="yolo-input" data-param="'+p.k+'">'+p.opts.map(function(o){
        return '<option value="'+esc(o)+'"'+(String(val)===String(o)?' selected':'')+'>'+(o===''?'（默认）':esc(o))+'</option>';
      }).join('')+'</select>';
    } else if(p.type==='path'){
      input='<div class="yolo-path"><input class="yolo-input" data-param="'+p.k+'" value="'+esc(val==null?'':val)+'" placeholder="'+esc(p.def||'')+'"><button class="yolo-pick" data-parampick="'+p.k+'" data-pick="'+(p.pick||'file')+'">…</button></div>';
    } else {
      var step = p.type==='int'?(p.step||1):(p.step||'any');
      input='<input class="yolo-input" type="number" step="'+step+'" data-param="'+p.k+'" value="'+esc(val==null?'':val)+'" placeholder="'+esc(p.def)+'">';
    }
    return '<div class="yolo-param'+(p.type==='bool'?' is-bool':'')+'">'+label+input+'</div>';
  }

  function trainProgressHtml(page){
    var r=page.data.run;
    var pct = r.total? Math.min(100, Math.round((r.epoch)/r.total*100)) : 0;
    var last = r.csv.length? r.csv[r.csv.length-1] : null;
    var eta = etaText(r);
    var statusMap={idle:'待训练',running:'训练中',done:'已完成',error:'出错',stopped:'已停止'};
    var mAP = last? fmt(pick(last,['mAP_0.5','mAP50(B)','mAP50'])) : '—';
    var mAP95 = last? fmt(pick(last,['mAP_0.5:0.95','mAP50-95(B)','mAP50-95'])) : '—';
    var pr = last? fmt(pick(last,['precision','precision(B)'])) : '—';
    var rc = last? fmt(pick(last,['recall','recall(B)'])) : '—';
    return '<div class="yolo-progress-card">'+
      '<div class="yolo-prog-head">'+
        '<span class="yolo-status yolo-status-'+r.status+'">'+(statusMap[r.status]||r.status)+'</span>'+
        '<span class="yolo-prog-epoch">'+(r.total?('Epoch '+r.epoch+' / '+r.total):'—')+'</span>'+
        '<span class="yolo-prog-eta">'+eta+'</span>'+
      '</div>'+
      '<div class="yolo-prog-track"><div class="yolo-prog-fill" id="yoloProgFill" style="width:'+pct+'%"></div><span class="yolo-prog-pct" id="yoloProgPct">'+pct+'%</span></div>'+
      '<div class="yolo-metrics" id="yoloMetrics">'+
        metricTile('mAP@.5', mAP, 'accent')+
        metricTile('mAP@.5:.95', mAP95, 'accent2')+
        metricTile('Precision', pr, 'ok')+
        metricTile('Recall', rc, 'warn')+
      '</div>'+
      '<div class="yolo-charts">'+
        '<div class="yolo-chart-box"><div class="yolo-chart-title">损失 Loss</div><canvas id="yoloChartLoss" height="150"></canvas></div>'+
        '<div class="yolo-chart-box"><div class="yolo-chart-title">精度 mAP</div><canvas id="yoloChartMap" height="150"></canvas></div>'+
      '</div>'+
    '</div>';
  }

  function metricTile(label,val,tone){
    return '<div class="yolo-metric yolo-tone-'+tone+'"><div class="yolo-metric-val">'+val+'</div><div class="yolo-metric-label">'+label+'</div></div>';
  }
  function fmt(v){ return (v==null||v===''||isNaN(v))?'—':(Number(v).toFixed(3)); }
  function pick(row,keys){ for(var i=0;i<keys.length;i++){ var k=keys[i]; if(row[k]!=null&&row[k]!=='') return row[k]; } return null; }
  function etaText(r){
    if(r.status!=='running'||!r.total||r.epoch<1||r.epochTs.length<2) return r.status==='running'?'预计 计算中…':'';
    var spans=[]; for(var i=1;i<r.epochTs.length;i++)spans.push(r.epochTs[i]-r.epochTs[i-1]);
    var avg=spans.reduce(function(a,b){return a+b;},0)/spans.length;
    var remain=(r.total-r.epoch)*avg;
    return '预计剩余 '+dur(remain);
  }
  function dur(ms){
    var s=Math.max(0,Math.round(ms/1000)); var h=Math.floor(s/3600),m=Math.floor(s%3600/60),ss=s%60;
    return (h?h+'h':'')+(m||h?m+'m':'')+ss+'s';
  }

  // ── 训练主视图事件绑定 ──
  function bindTrain(page){
    var d=page.data;
    // Python 选择/检测/依赖
    var pk=$('yoloPyPick'); if(pk)pk.addEventListener('change',function(){ d.py.path=pk.value; checkDeps(page); });
    var pp=$('yoloPyPath'); if(pp){ pp.addEventListener('input',function(){ d.py.path=pp.value; remember('pyPath',d.py.path); }); pp.addEventListener('change',function(){ checkDeps(page); }); }
    var pd=$('yoloPyDetect'); if(pd)pd.addEventListener('click',function(){ detectPythons(page); });
    var pm=$('yoloPyManual'); if(pm)pm.addEventListener('click',function(){ d.py.list=[]; render(page); });
    var eb=$('yoloEnvBtn'); if(eb)eb.addEventListener('click',function(){ envGate(page,true); });
    var di=$('yoloDepInstall'); if(di)di.addEventListener('click',function(){ installDeps(page,'ultra'); });
    var gi=$('yoloGpuInstall'); if(gi)gi.addEventListener('click',function(){ installDeps(page,'gpu'); });
    var dr=$('yoloDepRepair'); if(dr)dr.addEventListener('click',function(){ installDeps(page,'repair'); });
    // 版本/模型/数据集
    var ver=$('yoloVer'); if(ver)ver.addEventListener('change',function(){ d.ver=ver.value; d.model=recall('model_'+d.ver, verOf(d.ver).models[1]||verOf(d.ver).models[0]); remember('ver',d.ver); render(page); });
    var mdl=$('yoloModel'); if(mdl)mdl.addEventListener('change',function(){ d.model=mdl.value; remember('model_'+d.ver,d.model); });
    var ds=$('yoloDataset'); if(ds)ds.addEventListener('input',function(){ d.dataset=ds.value; remember('dataset',d.dataset); });
    var dsp=document.querySelector('[data-dspick]'); if(dsp)dsp.addEventListener('click',function(){ pickPath('file',function(p){ d.dataset=p; remember('dataset',p); if($('yoloDataset'))$('yoloDataset').value=p; },d.dataset); });
    var v5=$('yoloV5Dir'); if(v5)v5.addEventListener('input',function(){ d.yolov5dir=v5.value; remember('yolov5dir',d.yolov5dir); });
    var v5p=document.querySelector('[data-v5pick]'); if(v5p)v5p.addEventListener('click',function(){ pickPath('dir',function(p){ d.yolov5dir=p; remember('yolov5dir',p); if($('yoloV5Dir'))$('yoloV5Dir').value=p; },d.yolov5dir); });
    // 动作
    var op=$('yoloOpenParamsBtn'); if(op)op.addEventListener('click',function(){ d.paramsOpen=true; render(page); });
    var cp=$('yoloCfgPreview2'); if(cp)cp.addEventListener('click',function(){ previewConfig(page); });
    var start=$('yoloTrainStart'); if(start)start.addEventListener('click',function(){ startTrain(page); });
    var stop=$('yoloTrainStop'); if(stop)stop.addEventListener('click',function(){ stopTrain(page); });
    var raw=$('yoloRawToggle'); if(raw)raw.addEventListener('change',function(){ d.showRawLog=raw.checked; var box=$('yoloRawLog'); if(box)box.classList.toggle('show',raw.checked); });
    if(d.run.status==='running' && !pollTimers[page.id]) startPoll(page);
    requestAnimationFrame(function(){ drawCharts(page); });
    // 首次进入 YOLO：检测环境，缺则弹窗引导
    if(!d.py.detected){ d.py.detected=true; envGate(page); }
  }

  // ── 检测环境；force=true 无论缺不缺都弹窗（点「环境检测」按钮时）；否则仅缺才弹 ──
  function envGate(page, force){
    var d=page.data;
    invoke('yolo_detect_python',{}).then(function(res){
      d.py.list=(res&&res.pythons)||[];
      if(!d.py.path && d.py.list.length) d.py.path=d.py.list[0].path;
      if(!d.py.path){ d.py.checked=true; render(page); showEnvModal(page); return; }
      invoke('yolo_py_check',{python:d.py.path}).then(function(c){
        if(c&&c.ok){ d.py.torch=!!c.torch; d.py.ultra=!!c.ultralytics; d.py.cuda=!!c.cuda; d.py.gpu=c.gpu||''; d.py.tver=c.tver||''; d.py.uver=c.uver||''; }
        d.py.checked=true; render(page);
        if(force || !d.py.torch || !d.py.ultra) showEnvModal(page);
      }).catch(function(){ d.py.checked=true; render(page); showEnvModal(page); });
    }).catch(function(){ showEnvModal(page); });
  }
  function showEnvModal(page){
    var p=page.data.py, pyOk=!!p.path;
    var row=function(ok,name,note){ return '<div class="yolo-env-row"><span class="yolo-dep '+(ok?'ok':'no')+'">'+(ok?'✓':'✗')+' '+name+'</span><span class="yolo-env-note">'+esc(note)+'</span></div>'; };
    var status=
      row(pyOk,'Python', pyOk?('已找到 '+(p.tver?'':'')+p.path):'未检测到——请先安装 Python 3.9+')+
      row(p.torch,'PyTorch', p.torch?('已装 '+p.tver):'未安装')+
      row(p.ultra,'ultralytics', p.ultra?('已装 '+p.uver):'未安装')+
      (p.torch?row(p.cuda,'GPU(CUDA)', p.cuda?('可用 · '+(p.gpu||'')):'不可用（当前 CPU）'):'');
    var body=
      '<p class="yolo-env-intro">本工具只有几 MB、很轻量。训练/推理所需的 <b>Python 环境</b>请你自行安装一次（可复用，不占软件体积）。检测结果：</p>'+
      '<div class="yolo-env-status">'+status+'</div>'+ 
      '<div class="yolo-env-guide">'+
        (pyOk
          ? '缺依赖，两种方式任选：<br>① 点下方 <b>一键安装依赖</b> 自动装；<br>② 自己在命令行跑：<code>pip install ultralytics</code>　（要 GPU 加速再跑：<code>pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121 --force-reinstall</code>）'
          : '请先安装 Python（勾选 <b>Add Python to PATH</b>）：<code>https://www.python.org/downloads/</code><br>装好后点 <b>重新检测</b>。')+
      '</div>';
    var btns='<div class="yolo-env-btns" role="group" aria-label="环境操作">'+
      (pyOk?'<button class="yolo-btn primary" id="yoloEnvInstall">⬇ 一键安装依赖</button>':'')+
      (pyOk&&p.torch&&!p.cuda?'<button class="yolo-btn ghost" id="yoloEnvGpu">↑ 装 GPU 版</button>':'')+
      (pyOk?'<button class="yolo-btn ghost" id="yoloEnvRepair">🔧 修复依赖</button>':'')+
      '<button class="yolo-btn ghost" id="yoloEnvRecheck">↻ 重新检测</button>'+
      '<button class="yolo-btn ghost" id="yoloEnvClose">知道了</button>'+
    '</div>';
    JADE.showModal('<div class="modal-head"><h3>YOLO 环境检测</h3><button class="modal-close" onclick="JADE.closeModal()">×</button></div>'+
      '<div class="modal-body yolo-env-modal">'+body+btns+'</div>');
    var bi=$('yoloEnvInstall'); if(bi)bi.addEventListener('click',function(){ JADE.closeModal(); installDeps(page,'ultra'); });
    var bg=$('yoloEnvGpu'); if(bg)bg.addEventListener('click',function(){ JADE.closeModal(); installDeps(page,'gpu'); });
    var brp=$('yoloEnvRepair'); if(brp)brp.addEventListener('click',function(){ JADE.closeModal(); installDeps(page,'repair'); });
    var br=$('yoloEnvRecheck'); if(br)br.addEventListener('click',function(){ JADE.closeModal(); envGate(page); });
    var bc=$('yoloEnvClose'); if(bc)bc.addEventListener('click',function(){ JADE.closeModal(); });
  }

  // ── Python 检测 / 依赖 ──
  function detectPythons(page){
    var d=page.data; toast(page,'正在检测 Python…','info');
    invoke('yolo_detect_python',{}).then(function(res){
      if(res&&res.ok){ d.py.list=res.pythons||[]; if(!d.py.path&&d.py.list.length)d.py.path=d.py.list[0].path;
        render(page); if(d.py.path)checkDeps(page); toast(page,'检测到 '+d.py.list.length+' 个 Python','ok'); }
      else toast(page,'未检测到 Python，请手填路径','warn');
    }).catch(function(){ toast(page,'原生未就绪','error'); });
  }
  function checkDeps(page){
    var d=page.data; if(!d.py.path)return;
    remember('pyPath',d.py.path);
    invoke('yolo_py_check',{python:d.py.path}).then(function(res){
      if(res&&res.ok){ d.py.torch=!!res.torch; d.py.ultra=!!res.ultralytics; d.py.cuda=!!res.cuda; d.py.gpu=res.gpu||''; d.py.tver=res.tver||''; d.py.uver=res.uver||''; d.py.checked=true; render(page); }
    }).catch(function(){});
  }
  // 安装依赖：独立于训练状态（不触发"训练中/停止训练"），日志走原始日志区
  //  mode: 'ultra'(装ultralytics) | 'gpu'(装CUDA torch) | 'repair'(清损坏+强制重装干净torch+ultralytics)
  function installDeps(page, mode){
    if(mode===true)mode='gpu'; if(mode===false||mode==null)mode='ultra';
    var d=page.data; if(!d.py.path){ toast(page,'请先选择 Python','error'); return; }
    var pkg, hint;
    if(mode==='gpu'){ pkg='torch torchvision --index-url https://download.pytorch.org/whl/cu121 --force-reinstall --no-deps'; hint='正在安装 CUDA 版 PyTorch（约 2.5GB，请耐心）…\n'; }
    else if(mode==='repair'){ pkg='torch torchvision ultralytics --force-reinstall --no-cache-dir'; hint='正在清理损坏并强制重装干净的 PyTorch + ultralytics（约 200MB，请耐心）…\n'; }
    else { pkg='ultralytics'; hint='正在安装 ultralytics（含 PyTorch，请耐心）…\n'; }
    d.installing=true; d.showRawLog=true; d.installTs=Date.now();
    d.run.log = hint;
    toast(page,'开始安装/修复依赖…','info'); render(page);
    invoke('yolo_py_install',{python:d.py.path,pkg:pkg}).then(function(res){
      if(res&&res.ok){ pollInstall(page); }
      else { d.installing=false; render(page); toast(page,'启动安装失败','error'); }
    }).catch(function(){ d.installing=false; render(page); toast(page,'原生未就绪','error'); });
  }
  function pollInstall(page){
    var d=page.data;
    if(installTimers[page.id])clearInterval(installTimers[page.id]);
    installTimers[page.id]=setInterval(function(){
      invoke('yolo_train_poll',{}).then(function(res){
        if(!res||!res.ok)return;
        if(typeof res.log==='string'){ d.run.log=res.log; var pre=$('yoloRawLogPre'); if(pre){ pre.textContent=res.log; var b=$('yoloRawLog'); if(b)b.scrollTop=b.scrollHeight; } }
        // 进度：解析 pip 百分比 → 进度条；无百分比时走"不确定"动画
        var log=d.run.log||'', prog=$('yoloInstProg'), fill=$('yoloInstFill');
        var pcts=log.match(/(\d{1,3})%/g); var pct=pcts?parseInt(pcts[pcts.length-1],10):null;
        var sec=Math.round((Date.now()-(d.installTs||Date.now()))/1000);
        if(fill){ var wrap=fill.parentNode;
          if(pct!=null&&pct>=0&&pct<=100){ fill.style.width=pct+'%'; if(wrap)wrap.classList.remove('indet'); }
          else { fill.style.width='100%'; if(wrap)wrap.classList.add('indet'); } }
        if(prog){ var lines=log.split(/[\r\n]/).filter(function(x){return x.trim();}); var last=lines.length?lines[lines.length-1]:'';
          prog.textContent=(pct!=null?(pct+'% · '):'')+'已运行 '+sec+'s'+(last?(' · '+last.slice(-60)):''); }
        if(res.running===false){
          clearInterval(installTimers[page.id]); delete installTimers[page.id]; d.installing=false;
          var code=res.exitCode;
          if(code!=null && code!==0 && code!==-1){ d.showRawLog=true; render(page); toast(page,'❌ 安装失败（退出码 '+code+'）——看下方日志，常见：网络不通 / 无写权限 / 中断','error'); return; }
          // 装完真去检测，如实反馈
          invoke('yolo_py_check',{python:d.py.path}).then(function(c){
            if(c&&c.ok){ d.py.torch=!!c.torch; d.py.ultra=!!c.ultralytics; d.py.cuda=!!c.cuda; d.py.gpu=c.gpu||''; d.py.tver=c.tver||''; d.py.uver=c.uver||''; }
            d.py.checked=true; render(page);
            if(!d.py.torch||!d.py.ultra) toast(page,'⚠ 装完检测仍缺依赖——可能没真正装上（看日志末尾错误 / 换个有写权限的 Python 或虚拟环境）','warn');
            else toast(page,'✓ 依赖就绪，可以训练了','ok');
          }).catch(function(){ render(page); });
        }
      }).catch(function(){});
    },1200);
  }
  var installTimers={};

  // ── 训练参数页事件绑定 ──
  function bindParams(page){
    var d=page.data;
    Array.prototype.forEach.call(document.querySelectorAll('[data-param]'),function(el){
      var p=PARAM_INDEX[el.dataset.param];
      var ev = (el.type==='checkbox'||el.tagName==='SELECT')?'change':'input';
      el.addEventListener(ev,function(){
        if(el.type==='checkbox')d.train[p.k]=el.checked;
        else if(p.type==='int')d.train[p.k]=el.value===''?'':parseInt(el.value,10);
        else if(p.type==='float')d.train[p.k]=el.value===''?'':parseFloat(el.value);
        else d.train[p.k]=el.value;
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('.yolo-phelp'),function(h){
      h.addEventListener('mouseenter',function(){ showTip(h, h.dataset.help); });
      h.addEventListener('mouseleave',hideTip);
    });
    var back=$('yoloParamsBack'); if(back)back.addEventListener('click',function(){ d.paramsOpen=false; render(page); });
    var cfg=$('yoloCfgPreview'); if(cfg)cfg.addEventListener('click',function(){ previewConfig(page); });
    var rst=$('yoloResetParams'); if(rst)rst.addEventListener('click',function(){ d.train=defaultTrain(); render(page); });
  }

  // ── 按版本拼训练命令 ──
  function fwd(p){ return String(p||'').replace(/\\/g,'/'); }
  function buildTrainCmd(page){
    var d=page.data, t=d.train, cur=verOf(d.ver), proj='runs_yolo', name='train';
    var e=parseInt(t.epochs,10)||100, b=parseInt(t.batch,10)||16, s=parseInt(t.imgsz,10)||640;
    var lr0=parseFloat(t.lr0)||0.01, opt=t.optimizer||'SGD', pat=parseInt(t.patience,10)||100;
    if(cur.backend==='yolov5'){
      var cmd='"'+d.py.path+'" -u train.py --data "'+d.dataset+'" --weights '+d.model+' --epochs '+e+
        ' --batch-size '+b+' --imgsz '+s+' --optimizer '+opt+' --patience '+pat+' --project '+proj+' --name '+name+' --exist-ok';
      return { cmd:cmd, cwd:d.yolov5dir, project:proj, name:name };
    }
    var cwd = d.dataset ? d.dataset.replace(/[\\\/][^\\\/]*$/,'') : '';
    var py="from ultralytics import YOLO; m=YOLO('"+fwd(d.model)+"'); m.train(data='"+fwd(d.dataset)+"', epochs="+e+
      ", imgsz="+s+", batch="+b+", lr0="+lr0+", optimizer='"+opt+"', patience="+pat+", project='"+proj+"', name='"+name+"', exist_ok=True)";
    return { cmd:'"'+d.py.path+'" -c "'+py+'"', cwd:cwd, project:proj, name:name };
  }

  function previewConfig(page){
    var built=buildTrainCmd(page);
    var txt='工作目录: '+(built.cwd||'（当前目录）')+'\n\n命令:\n'+built.cmd;
    JADE.showModal(
      '<div class="modal-head"><h3>训练命令预览</h3><button class="modal-close" onclick="JADE.closeModal()">×</button></div>'+
      '<div class="modal-body"><pre class="yolo-cmd">'+esc(txt)+'</pre>'+
        '<button class="yolo-btn ghost sm" onclick="YOLO._copy(this)" data-copy="'+esc(built.cmd)+'">复制命令</button></div>');
  }

  function startTrain(page){
    var d=page.data, cur=verOf(d.ver);
    if(!d.py.path){ toast(page,'请先选择 Python 解释器（点“检测”）','error'); return; }
    if(cur.backend==='ultra' && d.py.checked && !d.py.ultra){ toast(page,'该 Python 缺 ultralytics —— 点“一键安装依赖”','error'); return; }
    if(!d.dataset){ toast(page,'请先选择数据集 data.yaml','error'); return; }
    if(cur.backend==='yolov5' && !d.yolov5dir){ toast(page,'经典 v5 需指定 yolov5 仓库目录','error'); return; }
    var built=buildTrainCmd(page);
    d._proj=built.project; d._name=built.name; d._cwd=built.cwd;
    d.run={ status:'running', epoch:0, total:parseInt(d.train.epochs,10)||0, log:'', csv:[], startTs:Date.now(), epochTs:[], msg:'' };
    render(page);
    invoke('yolo_train_start',{ cmd:built.cmd, cwd:built.cwd }).then(function(res){
      if(res&&res.ok){ startPoll(page); }
      else { d.run.status='error'; d.run.msg=(res&&res.error)||'启动失败'; render(page); }
    }).catch(function(){ d.run.status='error'; d.run.msg='原生未就绪'; render(page); });
  }

  function stopTrain(page){
    var d=page.data;
    invoke('yolo_train_stop',{}).catch(function(){});
    stopPoll(page.id);
    d.run.status='stopped';
    render(page);
  }

  function startPoll(page){
    stopPoll(page.id);
    pollTimers[page.id]=setInterval(function(){ pollTrain(page); },1500);
  }
  function stopPoll(id){ if(pollTimers[id]){ clearInterval(pollTimers[id]); delete pollTimers[id]; } }

  function pollTrain(page){
    var d=page.data;
    invoke('yolo_train_poll',{ cwd:d._cwd||'', project:d._proj||'runs_yolo', name:d._name||'train' }).then(function(res){
      if(!res||!res.ok) return;
      var r=d.run;
      if(typeof res.log==='string') r.log=res.log;
      if(res.csv&&res.csv.length){
        if(res.csv.length>r.csv.length){
          for(var i=r.epochTs.length;i<res.csv.length;i++) r.epochTs.push(Date.now());
        }
        r.csv=res.csv; r.epoch=res.csv.length;
      }
      if(typeof res.epoch==='number' && res.epoch>r.epoch) r.epoch=res.epoch;
      if(res.total) r.total=res.total;
      // 状态
      if(res.running===false){
        r.status = res.exitCode===0 ? 'done' : (r.status==='stopped'?'stopped':'error');
        stopPoll(page.id);
        render(page);
        return;
      }
      updateTrainDom(page);
    }).catch(function(){});
  }

  // 局部更新，避免整页重渲染丢焦点
  function updateTrainDom(page){
    var r=page.data.run;
    var pct = r.total? Math.min(100, Math.round(r.epoch/r.total*100)):0;
    var f=$('yoloProgFill'); if(f)f.style.width=pct+'%';
    var pc=$('yoloProgPct'); if(pc)pc.textContent=pct+'%';
    var ep=document.querySelector('.yolo-prog-epoch'); if(ep)ep.textContent=r.total?('Epoch '+r.epoch+' / '+r.total):'—';
    var et=document.querySelector('.yolo-prog-eta'); if(et)et.textContent=etaText(r);
    var last=r.csv.length?r.csv[r.csv.length-1]:null;
    if(last){
      var m=$('yoloMetrics');
      if(m)m.innerHTML=metricTile('mAP@.5',fmt(pick(last,['mAP_0.5','mAP50(B)','mAP50'])),'accent')+metricTile('mAP@.5:.95',fmt(pick(last,['mAP_0.5:0.95','mAP50-95(B)','mAP50-95'])),'accent2')+metricTile('Precision',fmt(pick(last,['precision','precision(B)'])),'ok')+metricTile('Recall',fmt(pick(last,['recall','recall(B)'])),'warn');
    }
    var pre=$('yoloRawLogPre'); if(pre&&page.data.showRawLog){ pre.textContent=r.log; var box=$('yoloRawLog'); if(box)box.scrollTop=box.scrollHeight; }
    drawCharts(page);
  }

  // ── 训练曲线（canvas 折线图，主题色自适应） ──
  function themeColors(){
    var cs=getComputedStyle(document.body);
    return {
      grid: cs.getPropertyValue('--line').trim()||'rgba(255,255,255,0.1)',
      text: cs.getPropertyValue('--muted').trim()||'#888',
      accent: cs.getPropertyValue('--accent').trim()||'#3b82f6',
      accent2: cs.getPropertyValue('--accent-2').trim()||'#22d3ee',
      ok: cs.getPropertyValue('--ok').trim()||'#22c55e',
      warn: cs.getPropertyValue('--warn').trim()||'#f59e0b',
      danger: cs.getPropertyValue('--danger').trim()||'#ef4444'
    };
  }
  function lineChart(cv, series, opts){
    if(!cv) return; var ctx=cv.getContext('2d');
    var dpr=window.devicePixelRatio||1;
    var W=cv.clientWidth||cv.parentNode.clientWidth||300, H=cv.height;
    cv.width=W*dpr; cv.height=H*dpr; ctx.scale(dpr,dpr);
    ctx.clearRect(0,0,W,H);
    var c=themeColors(); var padL=34,padR=8,padT=10,padB=18;
    var plotW=W-padL-padR, plotH=H-padT-padB;
    var all=[]; series.forEach(function(s){ all=all.concat(s.data.filter(function(v){return v!=null&&!isNaN(v);})); });
    if(!all.length){ ctx.fillStyle=c.text; ctx.font='11px sans-serif'; ctx.fillText('暂无数据',padL,padT+plotH/2); return; }
    var max=opts&&opts.max!=null?opts.max:Math.max.apply(null,all);
    var min=opts&&opts.min!=null?opts.min:Math.min.apply(null,all);
    if(max===min)max=min+1;
    var n=Math.max.apply(null,series.map(function(s){return s.data.length;}));
    var xN=Math.max(1,n-1);
    // 网格
    ctx.strokeStyle=c.grid; ctx.lineWidth=1; ctx.fillStyle=c.text; ctx.font='10px sans-serif'; ctx.textAlign='right';
    for(var g=0;g<=3;g++){ var yy=padT+plotH*g/3; ctx.beginPath(); ctx.moveTo(padL,yy); ctx.lineTo(W-padR,yy); ctx.stroke();
      ctx.fillText((max-(max-min)*g/3).toFixed(2), padL-4, yy+3); }
    // 折线
    series.forEach(function(s){
      ctx.strokeStyle=s.color; ctx.lineWidth=2; ctx.beginPath(); var started=false;
      s.data.forEach(function(v,i){ if(v==null||isNaN(v))return; var x=padL+plotW*(n>1?i/xN:0.5); var y=padT+plotH*(1-(v-min)/(max-min));
        if(!started){ctx.moveTo(x,y);started=true;}else ctx.lineTo(x,y); });
      ctx.stroke();
    });
    // 图例
    ctx.textAlign='left'; var lx=padL+2, ly=padT+8;
    series.forEach(function(s){ ctx.fillStyle=s.color; ctx.fillRect(lx,ly-7,10,3); ctx.fillStyle=c.text; ctx.fillText(s.name,lx+14,ly-3); lx+=ctx.measureText(s.name).width+30; });
  }
  function col(name){ return function(row){ var v=row[name]; return v==null?null:Number(v); }; }
  function pcol(keys){ return function(row){ var v=pick(row,keys); return v==null?null:Number(v); }; }
  function drawCharts(page){
    var r=page.data.run, c=themeColors();
    var box=r.csv.map(pcol(['train/box_loss'])), obj=r.csv.map(pcol(['train/obj_loss','train/dfl_loss'])), cls=r.csv.map(pcol(['train/cls_loss']));
    lineChart($('yoloChartLoss'),[
      {name:'box',data:box,color:c.accent},
      {name:'obj/dfl',data:obj,color:c.warn},
      {name:'cls',data:cls,color:c.danger}
    ]);
    lineChart($('yoloChartMap'),[
      {name:'mAP@.5',data:r.csv.map(pcol(['mAP_0.5','mAP50(B)','mAP50'])),color:c.ok},
      {name:'mAP@.5:.95',data:r.csv.map(pcol(['mAP_0.5:0.95','mAP50-95(B)','mAP50-95'])),color:c.accent2}
    ],{min:0,max:1});
  }

  // ════════════════ 推理面板 ════════════════
  function inferHtml(page){
    var f=page.data.infer;
    var visible=f.dets.filter(function(x){return x.conf>=f.conf;});
    var list = visible.length? visible.map(function(x,i){
      return '<div class="yolo-det-row" data-det="'+f.dets.indexOf(x)+'">'+
        '<span class="yolo-det-swatch" style="background:'+clsColor(x.cls)+'"></span>'+
        '<span class="yolo-det-name">'+esc(f.names[x.cls]||('class '+x.cls))+'</span>'+
        '<span class="yolo-det-conf">'+(x.conf*100).toFixed(1)+'%</span>'+
        '<span class="yolo-det-xy">'+Math.round(x.x)+','+Math.round(x.y)+' · '+Math.round(x.w)+'×'+Math.round(x.h)+'</span>'+
      '</div>';
    }).join('') : '<div class="yolo-empty">'+(f.status==='done'?'未检出目标（可调低置信度阈值）':'选择模型和图片后点“运行推理”')+'</div>';

    var counts={}; visible.forEach(function(x){var n=f.names[x.cls]||('class '+x.cls);counts[n]=(counts[n]||0)+1;});
    var chips=Object.keys(counts).map(function(k){return '<span class="yolo-count-chip">'+esc(k)+' <b>'+counts[k]+'</b></span>';}).join('');

    return '<div class="yolo-infer">'+
      '<div class="yolo-infer-toolbar">'+
        '<div class="yolo-io-field"><span>模型 .pt / .onnx（v5/v8/v11…，走 Python）</span>'+
          '<input class="yolo-input" id="yoloInferModel" value="'+esc(f.model)+'" placeholder="yolov5s.param"><button class="yolo-pick" data-inferpick="model" data-pick="file">…</button></div>'+
        '<div class="yolo-io-field"><span>图片</span>'+
          '<input class="yolo-input" id="yoloInferSrc" value="'+esc(f.source)+'" placeholder="待检测图片"><button class="yolo-pick" data-inferpick="source" data-pick="image">…</button></div>'+
        '<button class="yolo-btn primary" id="yoloRunInfer">'+(f.status==='running'?'<span class="yolo-spin"></span>推理中':'▶ 运行推理')+'</button>'+
      '</div>'+
      '<div class="yolo-slider-bar">'+
        sliderHtml('conf','置信度阈值 conf',f.conf)+
        sliderHtml('iou','NMS IoU',f.iou)+
        '<label class="yolo-names-field">类别名(逗号分隔,可留空)<input class="yolo-input" id="yoloNames" value="'+esc(f.names.join(','))+'" placeholder="person,car,dog…"></label>'+
      '</div>'+
      '<div class="yolo-infer-main">'+
        '<div class="yolo-canvas-wrap"><canvas id="yoloInferCanvas"></canvas>'+
          (f.imgData?'':'<div class="yolo-canvas-empty">🖼️<br>选择图片以预览</div>')+
        '</div>'+
        '<div class="yolo-det-panel">'+
          '<div class="yolo-det-head">检测结果 <span class="yolo-det-total">'+visible.length+'</span></div>'+
          '<div class="yolo-count-chips">'+chips+'</div>'+
          '<div class="yolo-det-list">'+list+'</div>'+
          (f.msg?'<div class="yolo-infer-msg">'+esc(f.msg)+'</div>':'')+
        '</div>'+
      '</div>'+
    '</div>';
  }

  function sliderHtml(k,label,val){
    return '<label class="yolo-slider"><span class="yolo-slider-label">'+label+' <b id="yolo_'+k+'_v">'+Number(val).toFixed(2)+'</b></span>'+
      '<input type="range" min="0" max="1" step="0.01" data-slider="'+k+'" value="'+val+'"></label>';
  }

  function bindInfer(page){
    var f=page.data.infer;
    var mi=$('yoloInferModel'); if(mi)mi.addEventListener('input',function(){f.model=mi.value; remember('inferModel',f.model);});
    var si=$('yoloInferSrc'); if(si)si.addEventListener('input',function(){f.source=si.value; remember('inferSource',f.source);});
    Array.prototype.forEach.call(document.querySelectorAll('[data-inferpick]'),function(btn){
      btn.addEventListener('click',function(){
        pickPath(btn.dataset.pick,function(p){
          if(btn.dataset.inferpick==='model'){ f.model=p; remember('inferModel',p); $('yoloInferModel').value=p; }
          else { f.source=p; remember('inferSource',p); $('yoloInferSrc').value=p; loadPreview(page,p); }
        },btn.dataset.inferpick==='model'?f.model:f.source);
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-slider]'),function(sl){
      sl.addEventListener('input',function(){
        var k=sl.dataset.slider; f[k]=parseFloat(sl.value);
        var lab=$('yolo_'+k+'_v'); if(lab)lab.textContent=f[k].toFixed(2);
        if(k==='conf'){ refreshDetList(page); drawDetections(page); }
      });
    });
    var nm=$('yoloNames'); if(nm)nm.addEventListener('input',function(){ f.names=nm.value.split(',').map(function(s){return s.trim();}).filter(Boolean); });
    var run=$('yoloRunInfer'); if(run)run.addEventListener('click',function(){ runInfer(page); });
    // 点击清单高亮
    Array.prototype.forEach.call(document.querySelectorAll('.yolo-det-row'),function(row){
      row.addEventListener('mouseenter',function(){ f._hi=parseInt(row.dataset.det,10); drawDetections(page); });
      row.addEventListener('mouseleave',function(){ f._hi=-1; drawDetections(page); });
    });
  }

  function loadPreview(page,path){
    var f=page.data.infer;
    invoke('yolo_read_image',{path:path}).then(function(res){
      if(res&&res.ok){ f.imgData=res.data; f.imgW=res.w; f.imgH=res.h; f.dets=[]; f.status='idle'; render(page); }
    }).catch(function(){});
  }

  function runInfer(page){
    var f=page.data.infer, d=page.data;
    if(!d.py.path){ toast(page,'请先在“训练”页检测/选择 Python 解释器','error'); return; }
    if(!f.model){ toast(page,'请先选择 .pt / .onnx 模型','error'); return; }
    if(!f.source){ toast(page,'请先选择要检测的图片','error'); return; }
    f.status='running'; f.msg=/\.onnx$/i.test(f.model)?'正在启动 ONNX Runtime 推理…':'首次调用需要加载 PyTorch，稍候…'; render(page);
    invoke('yolo_infer',{ python:d.py.path, model:f.model, image:f.source, conf:String(f.conf), iou:String(f.iou) },{timeout:330000}).then(function(res){
      if(!res||!res.ok){ f.status='error'; f.msg=(res&&res.error)||'推理失败'; render(page); return; }
      f.imgData=res.imgData||f.imgData; f.imgW=res.w||f.imgW; f.imgH=res.h||f.imgH;
      f.dets=(res.dets||[]).map(function(x){return {cls:x.cls,conf:x.conf,x:x.x,y:x.y,w:x.w,h:x.h};});
      if(res.names&&res.names.length&&!f.names.length) f.names=res.names;
      f.status='done'; f.msg=res.dets?('共 '+res.dets.length+' 个候选，检测 '+(res.inferMs!=null?Number(res.inferMs).toFixed(1):'?')+' ms · 总耗时 '+(res.totalMs!=null?Number(res.totalMs).toFixed(1):(res.ms!=null?Number(res.ms).toFixed(1):'?'))+' ms · '+(res.ep||'CPU')):''; render(page);
    }).catch(function(e){ f.status='error'; f.msg='原生未就绪：'+(e&&e.message||e); render(page); });
  }

  function refreshDetList(page){
    // 只重渲染推理面板（阈值滑动时）
    var f=page.data.infer, visible=f.dets.filter(function(x){return x.conf>=f.conf;});
    var tot=document.querySelector('.yolo-det-total'); if(tot)tot.textContent=visible.length;
    var listEl=document.querySelector('.yolo-det-list'); if(!listEl)return;
    listEl.innerHTML = visible.length? visible.map(function(x){
      return '<div class="yolo-det-row" data-det="'+f.dets.indexOf(x)+'"><span class="yolo-det-swatch" style="background:'+clsColor(x.cls)+'"></span><span class="yolo-det-name">'+esc(f.names[x.cls]||('class '+x.cls))+'</span><span class="yolo-det-conf">'+(x.conf*100).toFixed(1)+'%</span><span class="yolo-det-xy">'+Math.round(x.x)+','+Math.round(x.y)+' · '+Math.round(x.w)+'×'+Math.round(x.h)+'</span></div>';
    }).join('') : '<div class="yolo-empty">未检出目标（可调低置信度阈值）</div>';
    var counts={}; visible.forEach(function(x){var n=f.names[x.cls]||('class '+x.cls);counts[n]=(counts[n]||0)+1;});
    var chipsEl=document.querySelector('.yolo-count-chips');
    if(chipsEl)chipsEl.innerHTML=Object.keys(counts).map(function(k){return '<span class="yolo-count-chip">'+esc(k)+' <b>'+counts[k]+'</b></span>';}).join('');
    Array.prototype.forEach.call(document.querySelectorAll('.yolo-det-row'),function(row){
      row.addEventListener('mouseenter',function(){ f._hi=parseInt(row.dataset.det,10); drawDetections(page); });
      row.addEventListener('mouseleave',function(){ f._hi=-1; drawDetections(page); });
    });
  }

  function drawDetections(page){
    var f=page.data.infer, cv=$('yoloInferCanvas'); if(!cv||!f.imgData) return;
    // 缓存已解码图片，滑动 conf 阈值时不重复解码
    if(f._imgEl && f._imgSrc===f.imgData && f._imgEl.complete){ paintDet(page,cv,f._imgEl); return; }
    var img=new Image(); f._imgEl=img; f._imgSrc=f.imgData;
    img.onload=function(){ paintDet(page,cv,img); };
    img.src=f.imgData;
  }
  function paintDet(page,cv,img){
    var f=page.data.infer;
    var wrap=cv.parentNode, maxW=wrap.clientWidth-2, maxH=wrap.clientHeight-2;
    var scale=Math.min(maxW/img.width, maxH/img.height, 1); if(!isFinite(scale)||scale<=0)scale=Math.min(maxW/img.width||1,1);
    var dw=img.width*scale, dh=img.height*scale;
    var dpr=window.devicePixelRatio||1;
    cv.width=dw*dpr; cv.height=dh*dpr; cv.style.width=dw+'px'; cv.style.height=dh+'px';
    var ctx=cv.getContext('2d'); ctx.scale(dpr,dpr); ctx.clearRect(0,0,dw,dh);
    ctx.drawImage(img,0,0,dw,dh);
    f.dets.filter(function(x){return x.conf>=f.conf;}).forEach(function(x){
      var color=clsColor(x.cls), hi=(f._hi===f.dets.indexOf(x));
      var bx=x.x*scale, by=x.y*scale, bw=x.w*scale, bh=x.h*scale;
      ctx.lineWidth=hi?4:2; ctx.strokeStyle=color; ctx.strokeRect(bx,by,bw,bh);
      var label=(f.names[x.cls]||('class '+x.cls))+' '+(x.conf*100).toFixed(0)+'%';
      ctx.font='12px sans-serif'; var tw=ctx.measureText(label).width;
      ctx.fillStyle=color; ctx.fillRect(bx-1,by-16,tw+10,16);
      ctx.fillStyle='#fff'; ctx.fillText(label,bx+4,by-4);
    });
  }

  // ════════════════ 标注启动面板 ════════════════
  function annotHtml(page){
    var a=page.data.annot;
    return '<div class="yolo-annot-launch">'+
      '<div class="yolo-launch-card">'+
        '<div class="yolo-launch-ico">🏷️</div>'+
        '<h2>图像标注工作台</h2>'+
        '<p class="yolo-launch-desc">在独立的大窗口中标注数据集，导出 YOLO 格式(.txt)。支持画框/拖拽/缩放、类别管理、labelImg 风格快捷键。</p>'+
        '<div class="yolo-launch-actions">'+
          '<button class="yolo-btn primary lg" id="yoloOpenAnnot">🚀 打开标注窗口</button>'+
          '<button class="yolo-btn ghost" id="yoloAnnotPickDir">选择图片文件夹…</button>'+
        '</div>'+
        (a.lastDir?'<div class="yolo-launch-hint">最近：'+esc(a.lastDir)+'</div>':'')+
        '<div class="yolo-shortcuts">'+
          '<div class="yolo-sc-title">常用快捷键</div>'+
          shortcutGrid()+
        '</div>'+
      '</div>'+
    '</div>';
  }
  function shortcutGrid(){
    var sc=[['W','画框'],['Esc','取消/退选'],['Del','删除选中框'],['A / D','上一张 / 下一张'],
      ['Ctrl+S','保存标注'],['1-9','切换类别'],['Ctrl+滚轮','缩放'],['空格','下一张'],
      ['Ctrl+Z','撤销'],['Ctrl+Y','重做'],['F','适应窗口'],['H','隐藏/显示框']];
    return '<div class="yolo-sc-grid">'+sc.map(function(s){return '<div class="yolo-sc"><kbd>'+s[0]+'</kbd><span>'+s[1]+'</span></div>';}).join('')+'</div>';
  }
  function bindAnnot(page){
    var a=page.data.annot;
    var open=$('yoloOpenAnnot'); if(open)open.addEventListener('click',function(){ openAnnotator(page, a.lastDir); });
    var pick=$('yoloAnnotPickDir'); if(pick)pick.addEventListener('click',function(){ pickPath('dir',function(p){ a.lastDir=p; render(page); openAnnotator(page,p); },a.lastDir); });
  }
  function openAnnotator(page,dir){
    invoke('yolo_open_annotator',{dir:dir||''}).then(function(res){
      if(!res||!res.ok) toast(page,'打开标注窗口失败：'+((res&&res.error)||'原生未就绪'),'error');
    }).catch(function(e){ toast(page,'原生未就绪，无法打开标注窗口','error'); });
  }

  // ════════════════ CNN 识别（图片文字识别，不定长 CNN+CTC）════════════════
  //  数据集：一堆图片，文件名 = 内容_md5.png（'_'前为标签，md5仅防重名，忽略）
  function cnnHtml(page){
    var c=page.data.cnn;
    var sizeTxt = c.imgW&&c.imgH ? (c.imgW+' × '+c.imgH+' px') : '未获取';
    return '<div class="yolo-cnn">'+
      '<div class="yolo-nvidia">⚡ CNN 文字识别<b>模型很小，用 CPU 就够快</b>，<b>不需要 N 卡</b>；有 N 卡 / 核显(DirectML) 可选加速，但通常没必要。</div>'+
      '<div class="yolo-cnn-fmt">📄 数据集格式：一堆图片，<b>文件名即标签</b> —— <code>内容_随机md5.png</code>（<code>_</code> 前是图里的文字，md5 仅防重名）。'+
        '不定长 → 采用 <b>CNN + CTC</b>；一般<b>不含中文</b>（数字/字母，自动从文件名归纳字符集）。</div>'+
      '<div class="yolo-ds-row">'+
        '<div class="yolo-io-field"><span>样本文件夹（内容_md5.png）</span>'+
          '<input class="yolo-input" id="yoloCnnDs" value="'+esc(c.dataset)+'" placeholder="选择验证码/文字图片文件夹"><button class="yolo-pick" data-cnnpick="1" data-pick="dir">…</button></div>'+
        '<button class="yolo-btn ghost sm" id="yoloCnnAutoSize">📐 一键获取尺寸</button>'+
      '</div>'+
      '<div class="yolo-cnn-stats">'+
        cnnStat('样本数', c.count||'—')+
        cnnStat('图像尺寸', sizeTxt)+
        cnnStat('字符集', c.charset? (c.charset.length+' 类') : '—')+
        cnnStat('最大长度', c.maxLen||'—')+
      '</div>'+
      (c.sample?'<div class="yolo-cnn-sample">示例标签：<code>'+esc(c.sample)+'</code>　字符集：<code>'+esc(c.charset||'')+'</code></div>':'')+
      '<div class="yolo-cnn-actions">'+
        '<button class="yolo-btn primary sm" id="yoloCnnTrain">▶ 开始训练</button>'+
        '<span class="yolo-cnn-note">识别引擎（NVIDIA CNN+CTC）优先级靠后，正在规划接入；此页数据扫描/尺寸获取已可用。</span>'+
      '</div>'+
      (c.msg?'<div class="yolo-infer-msg">'+esc(c.msg)+'</div>':'')+
    '</div>';
  }
  function cnnStat(label,val){ return '<div class="yolo-metric yolo-tone-accent"><div class="yolo-metric-val">'+esc(String(val))+'</div><div class="yolo-metric-label">'+label+'</div></div>'; }

  function bindCnn(page){
    var c=page.data.cnn;
    var ds=$('yoloCnnDs'); if(ds)ds.addEventListener('input',function(){ c.dataset=ds.value; remember('cnnDataset',c.dataset); });
    var pk=document.querySelector('[data-cnnpick]'); if(pk)pk.addEventListener('click',function(){ pickPath('dir',function(p){ c.dataset=p; remember('cnnDataset',p); if($('yoloCnnDs'))$('yoloCnnDs').value=p; cnnScan(page); },c.dataset); });
    var az=$('yoloCnnAutoSize'); if(az)az.addEventListener('click',function(){ cnnScan(page); });
    var tr=$('yoloCnnTrain'); if(tr)tr.addEventListener('click',function(){ toast(page,'CNN 识别引擎优先级靠后，正在规划；数据扫描/尺寸获取已可用','info'); });
  }
  // 扫描数据集：一键获取尺寸 + 从文件名归纳标签/字符集/最大长度
  function cnnScan(page){
    var c=page.data.cnn; if(!c.dataset){ toast(page,'请先选择样本文件夹','error'); return; }
    invoke('yolo_list_images',{dir:c.dataset}).then(function(res){
      if(!res||!res.ok||!res.images||!res.images.length){ toast(page,'文件夹内没有图片','warn'); return; }
      c.count=res.images.length;
      // 从文件名归纳：'_' 前为标签
      var chars={}, maxLen=0, sample='';
      res.images.forEach(function(im){
        var base=im.name.replace(/\.[^.]+$/,''); var us=base.lastIndexOf('_');
        var label = us>0 ? base.slice(0,us) : base;
        if(!sample)sample=label;
        if(label.length>maxLen)maxLen=label.length;
        for(var i=0;i<label.length;i++)chars[label[i]]=1;
      });
      c.charset=Object.keys(chars).sort().join(''); c.maxLen=maxLen; c.sample=sample;
      // 一键获取尺寸：读第一张图
      invoke('yolo_read_image',{path:res.images[0].path}).then(function(ir){
        if(ir&&ir.ok){ c.imgW=ir.w; c.imgH=ir.h; }
        c.msg='已扫描 '+c.count+' 张，标签取"_"前段；如尺寸不一致，可裁剪/统一后再训。';
        render(page); toast(page,'扫描完成','ok');
      }).catch(function(){ render(page); });
    }).catch(function(){ toast(page,'原生未就绪，无法扫描','error'); });
  }

  // ════════════════ 公用小工具 ════════════════
  function pathDir(path){
    if(!path) return '';
    var p=String(path).replace(/[\\/]+$/,'');
    var i=Math.max(p.lastIndexOf('\\'),p.lastIndexOf('/'));
    return i>2 ? p.slice(0,i) : p;
  }
  function pickPath(kind, cb, initialPath){
    var ch = kind==='dir'?'yolo_pick_dir':'yolo_pick_file';
    var filter = kind==='image'?'图片 (*.jpg;*.png;*.bmp;*.jpeg;*.webp)|*.jpg;*.jpeg;*.png;*.bmp;*.webp':
                 kind==='file'?'所有文件 (*.*)|*.*':'';
    var startDir=kind==='dir' ? (initialPath||'') : pathDir(initialPath);
    invoke(ch,{filter:filter,initialDir:startDir}).then(function(res){ if(res&&res.ok&&res.path) cb(res.path); })
      .catch(function(){ /* 原生未就绪：静默 */ });
  }

  var tipEl=null;
  function showTip(anchor,text){
    hideTip(); tipEl=document.createElement('div'); tipEl.className='yolo-tip'; tipEl.textContent=text;
    document.body.appendChild(tipEl);
    var r=anchor.getBoundingClientRect();
    tipEl.style.left=Math.min(window.innerWidth-tipEl.offsetWidth-8, r.left)+'px';
    tipEl.style.top=(r.bottom+6)+'px';
  }
  function hideTip(){ if(tipEl){ tipEl.remove(); tipEl=null; } }

  function toast(page,msg,tone){
    var t=document.createElement('div'); t.className='yolo-toast yolo-toast-'+(tone||'info'); t.textContent=msg;
    document.body.appendChild(t);
    requestAnimationFrame(function(){ t.classList.add('show'); });
    setTimeout(function(){ t.classList.remove('show'); setTimeout(function(){t.remove();},300); },2600);
  }

  function onClose(page){ stopPoll(page.id); if(installTimers[page.id]){clearInterval(installTimers[page.id]);delete installTimers[page.id];} }

  window.YOLO = {
    defaultData: defaultData,
    render: render,
    onClose: onClose,
    _copy: function(btn){ JADE.copyText(btn.dataset.copy); btn.textContent='已复制 ✓'; setTimeout(function(){btn.textContent='复制命令';},1500); }
  };
})();
