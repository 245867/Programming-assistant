(function () {
  'use strict';

  // ── JADE 工具函数别名 ────────────────────────────────
  var $ = JADE.$;
  var esc = JADE.esc;
  var invoke = JADE.invoke;
  var parseMaybeJson = JADE.parseMaybeJson;
  var copyText = JADE.copyText;
  var showModal = JADE.showModal;
  var closeModal = JADE.closeModal;
  var kvRows = JADE.kvRows;
  var activePage = function(){return JADE.activePage(state);};
  window.activePage = function(){return JADE.activePage(state);};

  var INTERNAL_TESTS_ENABLED = false;
  var INTERNAL_TESTS_AUTORUN = false;

  // ── Tool Icons (inline SVG paths) ────────────────────────────
  // 侧栏导航图标已外置为 web/icons/<name>.svg，按路径加载（见 renderTools）。

  var toolDefs = {
    http: { _n:'HTTP 请求', _k:'POST / GET / cURL', icon:'http', _d:'请求调试 & cURL 导入。' },
    ws: { _n:'WebSocket', _k:'WS / WSS', icon:'ws', _d:'连接 & 消息会话。' },
    encoding: { _n:'编码转换', _k:'UTF-8 / GBK / Big5', icon:'encoding', _d:'编码、哈希、Base 转换。' },
    json: { _n:'JSON 解析', _k:'格式化 / 压缩 / 路径', icon:'json', _d:'格式化 & 路径索引。' },
    calculator: { _n:'程序猿计算器', _k:'DEC / HEX / BIN', icon:'calculator', _d:'进制、位宽、位运算。' },
    msaa: { _n:'MSAA 解析', _k:'窗口可访问性', icon:'msaa', _d:'无障碍组件树解析。' },
    process: { _n:'进程管理', _k:'Process', icon:'process', _d:'进程枚举 & 管理。' },
    color: { _n:'窗口取色', _k:'Color Picker', icon:'color', _d:'取色、格式转换。' },
    winspy: { _n:'窗口 SPY', _k:'Window Spy', icon:'winspy', _d:'窗口枚举 & 属性。' },
    proxy: { _n:'代理 IP', _k:'Proxy Check', icon:'proxy', _d:'批量验证 & 延迟排序。' },
    regex: { _n:'正则调试', _k:'RegExp', icon:'regex', _d:'匹配 & 分组查看。' },
    jspatch: { _n:'JS调试器', _k:'补环境 / 沙箱', icon:'jspatch', _d:'沙箱执行、补环境、语法高亮。' },
    yolo: { _n:'YOLO 工具', _k:'训练 / 标注 / 推理', icon:'yolo', _d:'YOLOv5 训练、图像标注、模型推理一体化。' }
  };

  var systemDefs = {
    settings: { _n:'设置', _k:'主题 / 字体 / 启动', icon:'settings', _d:'主题、字体、启动。' },
    about: { _n:'关于', _k:JADE.d('JPJ:eJa:JnJu:JtJ J:SJoJfJt'), icon:'about', _d:'开发者和联系方式。' }
  };

  var state = { pages: [], activeId: null, theme: localStorage.getItem('theme') || 'glass', contextPageId: null, contextKind: null };
  var wsMap = {};
  var wsNative = {};   // page.id -> { id: 原生连接id, timer: 轮询定时器 }

  // 向 WS 会话日志追加一行（直接更新 DOM，避免整页重渲染）
  function wsAppend(page,line){
    var ts=new Date().toLocaleTimeString();
    page.data.log=(page.data.log?page.data.log+'\n':'')+'['+ts+'] '+line;
    var ap=activePage();
    if(ap&&ap.id===page.id){var box=$('wsLog');if(box){box.textContent=page.data.log;box.scrollTop=box.scrollHeight;}}
  }

  // 需要携带 cookie / 自定义头时走原生 WinHTTP（浏览器 WebSocket 无法设置 Cookie 头）
  function wsUseNative(page){ return !!((page.data.cookie&&page.data.cookie.trim())||(page.data.headers&&page.data.headers.trim())); }
  function wsNativeStopPoll(pageId){ if(wsNative[pageId]&&wsNative[pageId].timer){clearInterval(wsNative[pageId].timer);wsNative[pageId].timer=null;} }

  function wsNativeConnect(page){
    page.data.log='';page.data.state='connecting';
    var hc=(page.data.headers||'').split('\n').filter(function(x){return x.trim();}).length;
    wsAppend(page,'CONNECTING → '+page.data.url);
    wsAppend(page,'  后端=原生WinHTTP  cookie='+((page.data.cookie||'').trim()?'已携带':'无')+'  附加头='+(hc?hc+'行':'无'));
    renderWs(page);
    invoke('ws_open',{url:page.data.url,cookie:page.data.cookie||'',headers:page.data.headers||''}).then(function(res){
      var r=typeof res==='string'?JSON.parse(res):res;
      if(!r||!r.ok){page.data.state='error';wsAppend(page,'ERROR 连接失败: '+((r&&r.error)||'unknown')+'  (后端=原生WinHTTP)');renderWs(page);return;}
      page.data.state='open';
      wsNative[page.id]={id:r.id,timer:null};
      wsAppend(page,'OPEN 已连接 ✓  后端=原生WinHTTP  握手HTTP='+(r.status||'?')+'  cookie='+((page.data.cookie||'').trim()?'已携带':'未携带'));
      wsAppend(page,'  → 开始监听消息（轮询 150ms），未收到消息≠未连接');
      renderWs(page);
      var connId=r.id;
      wsNative[page.id].timer=setInterval(function(){
        invoke('ws_poll',{id:connId}).then(function(pr){
          var p=typeof pr==='string'?JSON.parse(pr):pr;
          if(!p||!p.ok)return;
          if(p.messages&&p.messages.length)p.messages.forEach(function(m){wsAppend(page,'RECV ('+m.length+'B) '+m);});
          if(p.state&&p.state!==page.data.state&&(p.state==='closed'||p.state==='error')){
            page.data.state=p.state;
            var willRe=page.data.reconnect&&p.state!=='error';
            wsAppend(page,(p.state==='error'?'ERROR 连接异常断开':'CLOSE 连接已关闭')+'  state='+p.state+(willRe?'  → 1.5s 后自动重连…':''));
            wsNativeStopPoll(page.id);wsNative[page.id]=null;
            invoke('ws_close',{id:connId});  // 释放原生句柄并 join 收发线程
            renderWs(page);
            if(willRe){setTimeout(function(){if(activePage()&&activePage().id===page.id)wsNativeConnect(page);},1500);}
          }
        });
      },150);
    }).catch(function(e){page.data.state='error';wsAppend(page,'ERROR 调用原生 ws_open 失败: '+e.message);renderWs(page);});
  }
  function wsNativeSend(page,msg){
    if(!wsNative[page.id]){wsAppend(page,'WARN socket not open, send skipped. Please connect first.');return;}
    invoke('ws_send',{id:wsNative[page.id].id,data:msg}).then(function(res){
      var r=typeof res==='string'?JSON.parse(res):res;
      if(r&&r.ok)wsAppend(page,'SEND ('+msg.length+'B) '+msg);else wsAppend(page,'ERROR 发送失败: '+((r&&r.error)||''));
    });
  }
  function wsNativeClose(page){
    if(!wsNative[page.id]){wsAppend(page,'WARN no active socket');return;}
    var connId=wsNative[page.id].id;
    wsNativeStopPoll(page.id);wsNative[page.id]=null;
    invoke('ws_close',{id:connId});
    page.data.state='closed';wsAppend(page,'CLOSE 已主动关闭 (后端=原生WinHTTP)');renderWs(page);
  }
  var proxyTimers = {};
  var seq = 1;
  var transforms = [
    { id: 'utf-8', name: 'UTF-8', type: 'encoding' },
    { id: 'gbk', name: 'GBK', type: 'encoding' },
    { id: 'gb18030', name: 'GB18030', type: 'encoding' },
    { id: 'gb2312', name: 'GB2312', type: 'encoding' },
    { id: 'big5', name: 'Big5', type: 'encoding' },
    { id: 'shift_jis', name: 'Shift_JIS', type: 'encoding' },
    { id: 'euc-kr', name: 'EUC-KR', type: 'encoding' },
    { id: 'windows-1252', name: 'Windows-1252', type: 'encoding' },
    { id: 'base64-encode', name: 'Base64 Encode', type: 'text' },
    { id: 'base64-decode', name: 'Base64 Decode', type: 'text' },
    { id: 'url-encode', name: 'URL Encode', type: 'text' },
    { id: 'url-decode', name: 'URL Decode', type: 'text' },
    { id: 'hex-encode', name: 'Hex Encode', type: 'text' },
    { id: 'hex-decode', name: 'Hex Decode', type: 'text' },
    { id: 'unicode-decode', name: 'USC2转ANSI (\\u→中文)', type: 'text' },
    { id: 'unicode-encode', name: 'ANSI转USC2 (中文→\\u)', type: 'text' },
    { id: 'md5', name: 'MD5', type: 'hash' },
    { id: 'sha1', name: 'SHA-1', type: 'hash' },
    { id: 'sha256', name: 'SHA-256', type: 'hash' },
    { id: 'sha384', name: 'SHA-384', type: 'hash' },
    { id: 'sha512', name: 'SHA-512', type: 'hash' },
    { id: 'lower', name: 'Lowercase', type: 'text' },
    { id: 'upper', name: 'Uppercase', type: 'text' }
  ];
  window.transforms = transforms;
  var transformZhNames = {
    'utf-8':'UTF-8编码',
    'gbk':'GBK编码',
    'gb18030':'GB18030编码',
    'gb2312':'GB2312编码',
    'big5':'Big5编码',
    'shift_jis':'Shift_JIS编码',
    'euc-kr':'EUC-KR编码',
    'windows-1252':'Windows-1252编码',
    'base64-encode':'BASE64编码',
    'base64-decode':'BASE64解码',
    'url-encode':'URL编码',
    'url-decode':'URL解码',
    'hex-encode':'十六进制编码',
    'hex-decode':'十六进制解码',
    'unicode-decode':'USC2转ANSI',
    'unicode-encode':'ANSI转USC2',
    'md5':'MD5',
    'sha1':'SHA-1',
    'sha256':'SHA-256',
    'sha384':'SHA-384',
    'sha512':'SHA-512',
    'lower':'转小写',
    'upper':'转大写'
  };
  var lang = localStorage.getItem('lang') || 'zh';

  function tt(key) {
    if (lang === 'zh' || !lang) return key;  // Chinese: return key as-is
    // Comprehensive i18n dictionary (only used for non-Chinese)
    const dict = {
      // === Tool definitions (shortened descs) ===
      'HTTP 请求': 'HTTP Client', '请求调试 & cURL 导入。': 'API debug & cURL import.',
      'POST / GET / cURL': 'POST / GET / cURL',
      'WebSocket': 'WebSocket', '连接 & 消息会话。': 'Connect & chat session.',
      'WS / WSS': 'WS / WSS',
      '编码转换': 'Encoder', '编码、哈希、Base 转换。': 'Encode, hash & base.',
      'UTF-8 / GBK / Big5': 'UTF-8 / GBK / Big5',
      'JSON 解析': 'JSON Viewer', '格式化 & 路径索引。': 'Format & path index.',
      '格式化 / 压缩 / 路径': 'Format / Minify / Path',
      '程序猿计算器': 'Programmer Calc', '进制、位宽、位运算。': 'Base, bit width & ops.',
      'DEC / HEX / BIN': 'DEC / HEX / BIN',
      'MSAA 解析': 'MSAA Viewer', '无障碍组件树解析。': 'Accessibility tree.',
      '窗口可访问性': 'Accessibility',
      '进程管理': 'Process Mgr', '进程枚举 & 管理。': 'Process list & manage.',
      '窗口取色': 'Color Picker', '取色、格式转换。': 'Pick & convert color.',
      'Color Picker': 'Color Picker',
      '窗口 SPY': 'Window SPY', '窗口枚举 & 属性。': 'Window tree & props.',
      'Window Spy': 'Window Spy',
      '代理 IP': 'Proxy Checker', '批量验证 & 延迟排序。': 'Batch validate & sort.',
      'Proxy Check': 'Proxy Check',
      '正则调试': 'RegExp Tester', '匹配 & 分组查看。': 'Match & group view.',
      'RegExp': 'RegExp',
      '设置': 'Settings', '主题、字体、启动。': 'Theme, font & startup.',
      '主题 / 字体 / 启动': 'Theme / Font / Startup',
      '关于': 'About', '开发者和联系方式。': 'Developer & contact.',
      // === JS调试器 ===
      'JS调试器': 'JS Debugger', '补环境 / 沙箱': 'Sandbox / Patch',
      '沙箱执行、补环境、语法高亮。': 'Sandbox, env patch & highlight.',
      '粘贴即运行：实时检测缺失变量，一键补环境，沙箱执行。': 'Sandbox exec, env detect & patch.',
      '运行': 'Run', '格式化': 'Beautify', '压缩': 'Minify',
      '清空输出': 'Clear', '检测环境': 'Detect Env', '停止': 'Stop',
      '一键补环境': 'Patch Env',
      [JADE.d('JPJ:eJa:JnJu:JtJ J:SJoJfJt')]: JADE.d('JPJ:eJa:JnJu:JtJ J:SJoJfJt'),

      // === Settings modal ===
      '外观': 'Appearance', '系统': 'System', '快捷键': 'Shortcuts',
      '字体大小': 'Font Size', '语言': 'Language',
      '主题': 'Theme', '字体': 'Font', '开机启动': 'Startup',
      '半透明毛玻璃': 'Glass (Acrylic)', '纯黑': 'Solid Black', '珍珠白': 'Pearl White',
      '中文': '中文', 'English': 'English',
      '保存': 'Save', '开发者': 'Developer',
      '加载字体中...': 'Loading fonts...',
      '发送请求': 'Send Request', '新建页面': 'New Page', '关闭页面': 'Close Page',
      '切换页面': 'Switch Page', '刷新数据': 'Refresh', '切标签': 'Go to Tab',

      // === HTTP ===
      '收藏': 'Favorite', '历史': 'History', '模板': 'Templates',
      '导入 cURL': 'Import cURL', '复制响应': 'Copy Response',
      '发送': 'Send', '原生': 'Native', '复制代码': 'Copy Code',
      '等待请求...': 'Awaiting request...',
      '请求中...': 'Sending...', '请求失败：': 'Request failed: ', '原生请求失败：': 'Native request failed: ',
      '复制的链接缺少协议，自动补 https://。': 'Protocol missing, prepended https://.',
      '粘贴浏览器或终端复制的 cURL：': 'Paste cURL copied from browser/terminal:',
      '暂未发送请求。': 'No requests sent yet.',
      '生成的请求代码 (': 'Generated Code (',
      '生成的请求代码': 'Generated Code',
      '复制到剪贴板': 'Copy to Clipboard',
      '请求模板 (': 'Templates (',

      // === WebSocket ===
      '连接': 'Connect', '关闭': 'Disconnect', '清空': 'Clear', '复制日志': 'Copy Log',
      '发送消息': 'Send', '发送前压缩 JSON': 'Auto-minify JSON', '断线自动重连': 'Auto-reconnect',
      '未连接': 'Not connected',
      'WebSocket 未连接，不允许发送。': 'WebSocket not connected.',
      'WebSocket 连接关闭。': 'WebSocket closed.',

      // === Encoder ===
      '转换': 'Convert', '复制结果': 'Copy', '一键全转': 'All Formats',
      '一键全转生成编码、Base、Hash 预览。': 'Click "All Formats" for preview.',
      '转换中...': 'Converting...',

      // === JSON ===
      '解析': 'Parse', '格式化': 'Format', '压缩': 'Minify', '复制结果': 'Copy',
      '点击解析 JSON': 'Click Parse to process JSON',
      '解析后选择树节点生成代码': 'Select a tree node to generate code',
      '代码生成': 'Code Generator',
      '生成代码': 'Generate Code',
      '生成正则代码': 'Generate Regex Code',
      '查看并复制代码': 'View & Copy Code',
      'JSON 库': 'JSON Library',
      '无输出数据': 'No output data',
      'JSON 错误: ': 'JSON error: ',
      '不是有效 JSON：': 'Invalid JSON: ',
      'JSON Diff': 'JSON Diff',
      'JSON A (当前)': 'JSON A (current)',
      'JSON B (对比)': 'JSON B (compare)',
      '粘贴要对比的 JSON...': 'Paste JSON to compare...',
      '执行 Diff': 'Run Diff',
      '两个 JSON 完全一致。': 'Identical JSON.',

      // === Calculator ===
      'BIN': 'BIN', 'OCT': 'OCT', 'DEC': 'DEC', 'HEX': 'HEX',
      'QWORD': 'QWORD', 'DWORD': 'DWORD', 'WORD': 'WORD', 'BYTE': 'BYTE',

      // === MSAA ===
      '解析 HWND': 'Parse HWND', '复制结果': 'Copy',
      'ACC 组件树': 'ACC Tree', 'MSAA控件树': 'MSAA Widget Tree', '窗口层级树': 'Window Hierarchy', '节点详情': 'Node Details',
      '等待选择窗口...': 'Awaiting window selection...',
      '输入 HWND 后解析，或使用瞄准镜选择窗口。': 'Enter HWND or use scope to target a window.',
      '选择树节点查看详情。': 'Select a tree node for details.',
      '输入目标窗口 HWND 后点击解析，或使用瞄准镜选择窗口。': 'Enter target HWND or use scope.',
      '解析完成 ': 'Parsed ',
      '解析中...': 'Parsing...',
      '(无 MSAA 树)': '(no MSAA tree)',
      '解析失败：': 'Parse failed: ',

      // === Process ===
      '刷新进程': 'Refresh', '终止进程': 'Kill', '打开位置': 'Open Path',
      '点击刷新枚举系统进程。': 'Click Refresh to enumerate processes.',
      '读取中...': 'Loading...',
      '(右键操作)': '(Right-click to act)',
      '进程名': 'Name', 'PID': 'PID', '权限': 'Priority', '线程': 'Thr', '内存': 'Memory', 'CPU': 'CPU',
      'Total': 'Total', 'Memory': 'Memory',
      'Admin': 'Admin', 'User': 'User', 'Sys': 'Sys',
      '受保护': 'Protected',
      '确定要终止 ': 'Confirm kill ',
      '已终止 PID ': 'Killed PID ',
      '失败：': 'Failed: ',
      '终止失败：': 'Kill failed: ',
      '打开失败：': 'Open failed: ',

      // === Color ===
      '屏幕取色': 'Pick Color', '记录': 'Save', '清空': 'Clear',
      '点击屏幕取色读取鼠标所在像素。': 'Click Pick Color to capture pixel.',
      '历史记录 (': 'History (',
      'RGB 调节': 'RGB Adjust', 'HSL 调节': 'HSL Adjust',
      '色值格式': 'Formats',
      'HEX': 'HEX', 'RGB': 'RGB', 'RGBA': 'RGBA', 'HSL': 'HSL', 'CMYK': 'CMYK',
      '复制': 'Copy',

      // === SPY ===
      '刷新窗口树': 'Refresh', '解析': 'Parse',
      '点击刷新窗口树枚举顶层窗口。': 'Click Refresh to enumerate windows.',

      // === Proxy ===
      '验证代理': 'Validate', '开始定时': 'Start Cron', '停止定时': 'Stop Cron',
      '支持 ip:port、协议://ip:port、ip:port@协议': 'Supports ip:port, proto://ip:port, ip:port@proto',
      '等待验证。': 'Awaiting validation...',
      '验证中...': 'Validating...',
      'API 提取验证中...': 'Fetching from API...',

      // === Regex ===
      '匹配': 'Match', '替换': 'Replace', '复制结果': 'Copy',
      '收藏': 'Save', '模板': 'Snippets',
      '正则模板 (': 'Regex Snippets (',
      '易语言': 'E Lang',
      '暂无收藏': 'Empty',
      '使用': 'Load',

      // === Generic ===
      '加载中...': 'Loading...',
      '计算': 'Calc', '复制结果': 'Copy',
      '批量验证': 'Validate', 'API提取验证': 'API Fetch', '启动定时': 'Start Cron', '停止定时': 'Stop Cron',
      '复制存活': 'Copy Alive', '清空结果': 'Clear',
      '搜索进程名...': 'Search process...', '隐藏系统进程': 'Hide System',
      '关闭进程': 'Kill', '打开文件夹': 'Open Folder', '提取图标': 'Extract Icon',
      '提取图标保存': 'Save Icon', '打开文件位置': 'Open Location',
      '关闭页面': 'Close Tab', '新建同类页面': 'New Tab', '复制当前页面': 'Duplicate',
      '关闭其他标签': 'Close Others', '关闭全部标签': 'Close All',
      '复制信息': 'Copy Info', '终止进程': 'Kill Process',
      'Jade 编程助手 version 1.3': 'Jade Programmer Assistant v1.3',
      '未定义': 'Undefined',
      '无法访问': 'Inaccessible',
      '未检测到缺失变量': 'No missing globals detected',
      '暂无': 'None',
      '一键补环境': 'Patch Env',
      // === Proxy page ===
      '批量代理': 'Proxy List', '多行代理': 'Proxies', '最大延迟 ms': 'Max Delay ms',
      '并发': 'Concurrency', 'API 提取 / 定时': 'API / Cron',
      'API URL': 'API URL', '格式': 'Format', '间隔秒': 'Interval (s)',
      'JSON 数据字段': 'JSON Field', 'IP 字段': 'IP Field', '端口字段': 'Port Field',
      '保存路径': 'Save Path', '追加保存': 'Append', '验证结果': 'Results',
      '等待验证...': 'Awaiting validation...',
      '总数': 'Total', '存活': 'Alive', '死亡': 'Dead',
      '为空': 'is empty', 'API 没有提取到代理': 'No proxies from API',
      'Headers（含Query参数和Cookie）': 'Headers (Query & Cookie)',
      'Body': 'Body',
      '自动编码(响应转UTF-8)': 'Auto-decode to UTF-8',
      '点击"一键全转"生成编码、Base、Hash 预览。': 'Click "All Formats" for preview.',
      [JADE.d('JPJ:eJa:JnJu:JtJ J:SJoJfJt:J J·J JQJQ:J J2J4J5J8J6J7')]: JADE.d('JPJ:eJa:JnJu:JtJ J:SJoJfJt:J J·J JQJQ:J J2J4J5J8J6J7'),
      '内部自测 ': 'Internal Test ',
      '失败数：': 'Failures: ',
      '标题栏作者固定': 'Title bar author check',
      '工具定义数量': 'Tool def count',
      '默认页面存在': 'Default page exists',
      '确认解析 JSON': 'Parse JSON?',
      '解析 HTTP 响应 JSON 到新页': 'Parse HTTP response JSON',
      '新建同类页面': 'New same-type page',
      '复制当前页面': 'Duplicate page',
      '关闭页面': 'Close page',
      '复制信息': 'Copy info',
      '终止进程': 'Kill process',
      '打开文件位置': 'Open file location',
      '复制': 'Copy',
      '瞄准镜拖拽拾取窗口': 'Scope: drag to target window',
      '瞄准镜选择窗口': 'Scope: target a window',
      '窗口属性': 'Window Props', '窗口树': 'Window Tree',
      'Process List': 'Process List',
      'Request': 'Request', 'Response': 'Response', 'Body': 'Body', 'Headers': 'Headers',
      'Query Params': 'Query Params',
      'Connection': 'Connection', 'Session Log': 'Session Log',
      'Message': 'Message', 'URL': 'URL',
      '目标窗口': 'Target Window',
      '正则匹配、分组查看和常用语法提示。': 'Regex matching, group view & syntax hints.',
      '转换 / 校验类型': 'Transform / Check',
      'Name': 'Name', 'Role': 'Role', 'State': 'State',
      'Value': 'Value', 'Description': 'Description', 'Children': 'Children',
      '暂无窗口树数据，请点击"刷新窗口树"按钮枚举系统窗口。': 'No window tree. Click Refresh.',
      '无标题': 'Untitled',
      [JADE.d('J©J: J2:J0J2:J6J J:PJeJaJn:JuJtJ JSJo:JfJtJ.J JAJlJlJ: JrJi:JgJhJtJsJ JrJeJsJe:JrJ:vJeJdJ.')]: JADE.d('J©J: J2:J0J2:J6J J:PJeJaJn:JuJtJ JSJo:JfJtJ.J JAJlJlJ: JrJi:JgJhJtJsJ JrJeJsJe:JrJ:vJeJdJ.'),
      'Built with ❤ using JadeView': 'Built with ❤ using JadeView',
      '独立开发者 | Full-Stack Developer': 'Indie Developer | Full-Stack',
      '请求中...': 'Sending...',
    };
    return dict[key] || key;
  }
  window.tt = tt;

  function testLog(line) {
    var clean=String(line).replace(/[\r\n]+/g,' | ');
    console.log('[TEST]',clean);
    return invoke('test_log',{line:clean}).catch(function(){});
  }
  function assertTest(results,name,condition,detail) {
    var item={name:name,ok:Boolean(condition),detail:detail||''};
    results.push(item);
    testLog((item.ok?'PASS ':'FAIL ')+name+(detail?' - '+detail:''));
    return item.ok;
  }
  function showTestResults(results) {
    var pass=results.filter(function(r){return r.ok;}).length;
    var fail=results.length-pass;
    showModal('<div class="modal-head"><div class="modal-title">内部自测 '+pass+'/'+results.length+'</div><button class="modal-close" id="closeModal">×</button></div><div class="test-log">'+results.map(function(r){return'<div class="'+(r.ok?'test-pass':'test-fail')+'">'+(r.ok?'PASS':'FAIL')+' · '+esc(r.name)+(r.detail?' · '+esc(r.detail):'')+'</div>';}).join('')+'</div><p class="tiny">失败数：'+fail+'。详细日志写入 logs/test.log。</p>');
  }
  var internalTestsRunning = false;

  async function runInternalTests() {
    if(internalTestsRunning)return;
    internalTestsRunning=true;
    var results=[];
    await testLog('=== runInternalTests start ===');
    assertTest(results,'标题栏作者固定',$('activeSubtitle')&&$('activeSubtitle').textContent.indexOf(JADE.d('JPJ:eJa:JnJu:JtJ J:SJoJfJt'))>=0);
    assertTest(results,'工具定义数量',Object.keys(toolDefs).length>=10,String(Object.keys(toolDefs).length));
    assertTest(results,'默认页面存在',state.pages.length>=1);
    assertTest(results,'MD5 abc',md5('abc')==='900150983cd24fb0d6963f7d28e17f72',md5('abc'));
    try{var sha=await convertText('abc','sha256');assertTest(results,'SHA256 abc',sha.indexOf('ba7816bf')===0,sha.slice(0,16));}catch(e){assertTest(results,'SHA256 abc',false,e.message);}
    try{var b64=await convertText('abc','base64-encode');assertTest(results,'Base64 encode',b64==='YWJj',b64);}catch(e){assertTest(results,'Base64 encode',false,e.message);}
    try{var hx=await convertText('abc','hex-encode');assertTest(results,'Hex encode',hx==='616263',hx);}catch(e){assertTest(results,'Hex encode',false,e.message);}
    try{var jpd=defaultData('json');jpd.input='{"a":{"b":[1]}}';var fakePage={data:jpd};var obj=JSON.parse(jpd.input);var nodes=[];walkJson(obj,'$',nodes,0);assertTest(results,'JSON tree nodes',nodes.length===4,String(nodes.length));assertTest(results,'zyjson code gen',makeZyCode('$.a.b[0]','cpp').indexOf('["a"]')>=0);}catch(e){assertTest(results,'JSON parse/code',false,e.message);}
    try{var re=new RegExp('(?<word>\\w+)','g');var m=re.exec('abc');assertTest(results,'Regex named group',m&&m.groups.word==='abc');}catch(e){assertTest(results,'Regex named group',false,e.message);}
    try{var cd=calcDisplay({value:255,word:8});assertTest(results,'Calculator bin width',cd.bin==='0b11111111',cd.bin);}catch(e){assertTest(results,'Calculator bin width',false,e.message);}
    try{var fonts=await invoke('get_fonts',{});var fontData=typeof fonts==='string'?JSON.parse(fonts):fonts;assertTest(results,'IPC get_fonts',fontData.ok&&fontData.fonts&&fontData.fonts.length>0,String((fontData.fonts||[]).length));}catch(e){assertTest(results,'IPC get_fonts',false,e.message);}
    try{var procs=await invoke('list_processes',{});var procItems=procs.items||procs.processes||[];assertTest(results,'IPC list_processes',procs.ok&&procItems.length>0,String(procItems.length));}catch(e){assertTest(results,'IPC list_processes',false,e.message);}
    try{var color=await invoke('pick_screen_color',{});assertTest(results,'IPC pick_screen_color',color.ok&&/^#[0-9A-F]{6}$/i.test(color.hex||''),color.hex||'');}catch(e){assertTest(results,'IPC pick_screen_color',false,e.message);}
    try{var wins=await invoke('spy_windows',{});var winItems=wins.items||wins.windows||[];assertTest(results,'IPC spy_windows',wins.ok&&winItems.length>0,String(winItems.length));}catch(e){assertTest(results,'IPC spy_windows',false,e.message);}
    try{var spyTree=await invoke('spy_tree',{limit:'120'});assertTest(results,'IPC spy_tree',spyTree.ok&&Array.isArray(spyTree.items)&&spyTree.items.length>0,String((spyTree.items||[]).length));}catch(e){assertTest(results,'IPC spy_tree',false,e.message);}
    try{var spyDetail=await invoke('spy_detail',{hwnd:'1e0b5a'});assertTest(results,'IPC spy_detail',spyDetail.ok&&Boolean(spyDetail.hwnd)&&Boolean(spyDetail.className),(spyDetail.hwnd||'')+' '+(spyDetail.className||spyDetail.error||''));}catch(e){assertTest(results,'IPC spy_detail 1e0b5a',false,e.message);}
    try{var proxyCheck=await invoke('proxy_validate',{input:'127.0.0.1:1',maxDelayMs:'120',concurrency:'1'});assertTest(results,'IPC proxy_validate',proxyCheck.ok&&Array.isArray(proxyCheck.dead),'alive='+(proxyCheck.alive||[]).length+' dead='+(proxyCheck.dead||[]).length);}catch(e){assertTest(results,'IPC proxy_validate',false,e.message);}
    try{var msaa=await invoke('inspect_msaa',{hwnd:'1e0b5a'});var msaaData=typeof msaa==='string'?JSON.parse(msaa):msaa;assertTest(results,'MSAA hwnd 1e0b5a call',typeof msaaData.ok==='boolean',JSON.stringify(msaaData.window||msaaData.error||{}).slice(0,80));}catch(e){assertTest(results,'MSAA hwnd 1e0b5a call',false,e.message);}
    render();
    await testLog('=== runInternalTests end ===');
    internalTestsRunning=false;
    showTestResults(results);
  }

  function defaultData(type) {
    if (type==='http') return {method:'GET',protocol:'auto',url:'https://www.baidu.com',proxy:'',headers:'Accept: */*',body:'',result:'等待请求...',raw:'',responseHeaders:'',responseBody:'',responseView:'raw',useNative:true,metrics:{},codeLang:'e',autoDecode:true};
    if (type==='ws') return {url:'wss://echo.websocket.org',message:'Hello Jade',log:'',state:'closed',autoJson:false,reconnect:false,cookie:'',headers:''};
    if (type==='encoding') return {input:'中文 ABC 123',target:'utf-8',result:'等待转换...',allResult:''};
    if (type==='json') return {input:'{\n  "hello":"jade",\n  "items":[1,2,3]\n}',output:'点击解析 JSON',tree:[],selectedPath:'$',codeLang:'cpp',codeLibs:{},code:'',codePy:'',codeE:''};
    if (type==='calculator') return {expr:'0xff + 42',value:297,word:64,signed:false,base:'DEC'};
    if (type==='msaa') return {hwnd:'',result:'输入目标窗口 HWND 后点击解析，或使用瞄准镜选择窗口。',tree:null,selectedPath:'0',selectedNode:null};
    if (type==='process') return {result:[],rawData:'点击刷新枚举系统进程。',_hideSystem:true};
    if (type==='color') return {color:'#3b82f6',history:[],result:'点击屏幕取色读取鼠标所在像素。'};
    if (type==='winspy') return {hwnd:'',tree:[],detail:null,result:'点击"刷新窗口树"枚举顶层窗口。'};
    if (type==='proxy') return {input:'http://127.0.0.1:8080\n# 支持 ip:port、协议://ip:port、ip:port@协议',maxDelayMs:3000,concurrency:200,alive:[],dead:[],summary:'等待验证。',apiUrl:'',apiFormat:'auto',jsonDataField:'data',ipField:'ip',portField:'port',intervalSec:10,savePath:'./alive_proxies.txt',appendMode:false,timerEnabled:false,timerId:null};
    if (type==='regex') return {pattern:'\\w+',flags:'g',text:'Hello Jade 123\n'+JADE.d('JPJ:eJa:JnJu:JtJ J:SJoJfJt')+' '+JADE.d('J2J:4J5:J8J6:J7'),replacement:'***',replaced:'',result:[],regexError:'',viewMode:'match'};
    if (type==='jspatch') return {code:'// 粘贴代码，点运行\nconsole.log("Hello JS调试器！");\n',output:'',missing:[],patched:{}};
    if (type==='yolo') return (window.YOLO&&YOLO.defaultData)?YOLO.defaultData():{sub:'train'};
    if (type==='settings') return {theme:state.theme,fontSize:Number(localStorage.getItem('fontSize')||13),startup:localStorage.getItem('startup')==='1'};
    if (type==='about') return {};
    return {};
  }

  function createPage(type, source) {
    var def=toolDefs[type]||systemDefs[type];
    var count=state.pages.filter(function(p){return p.type===type;}).length+1;
    var page={id:'p'+seq++,type:type,title: tt(def._n)+' '+count,data:source?JSON.parse(JSON.stringify(source.data)):defaultData(type)};
    if(systemDefs[type])page.title= tt(def._n);
    state.pages.push(page);
    state.activeId=page.id;
    render();
  }

  function createJsonPageFromText(title,text) {
    var page={id:'p'+seq++,type:'json',title:title||'JSON 解析',data:defaultData('json')};
    page.data.input=text||'';
    state.pages.push(page);
    state.activeId=page.id;
    render();
    parseJson(page,false);
  }

  function closePage(id) {
    if(state.pages.length<=1)return;
    var idx=state.pages.findIndex(function(p){return p.id===id;});
    if(idx<0)return;
    var page=state.pages[idx];
    if(page.type==='ws'&&wsMap[page.id])wsMap[page.id].close();
    if(page.type==='ws'&&wsNative[page.id]){wsNativeStopPoll(page.id);invoke('ws_close',{id:wsNative[page.id].id});wsNative[page.id]=null;}
    if(page.type==='yolo'&&window.YOLO&&YOLO.onClose)YOLO.onClose(page);
    state.pages.splice(idx,1);
    if(state.activeId===id)state.activeId=state.pages[Math.max(0,idx-1)].id;
    render();
  }
  function closeAllPages(keepId) {
    if(state.pages.length<=1)return;
    // 保留 keepId 指定的页，或保留第一页
    var keep = keepId ? state.pages.find(function(p){return p.id===keepId;}) : null;
    if (!keep) keep = state.pages[0];
    // 先关 WebSocket
    state.pages.forEach(function(p){ if(p.id!==keep.id&&p.type==='ws'&&wsMap[p.id]) wsMap[p.id].close(); });
    state.pages.forEach(function(p){ if(p.id!==keep.id&&p.type==='ws'&&wsNative[p.id]){wsNativeStopPoll(p.id);invoke('ws_close',{id:wsNative[p.id].id});wsNative[p.id]=null;} });
    state.pages = [keep];
    state.activeId = keep.id;
    render();
  }
  function closeOtherPages(id) {
    if(state.pages.length<=1)return;
    var keep = state.pages.find(function(p){return p.id===id;});
    if (!keep) return;
    state.pages.forEach(function(p){ if(p.id!==id&&p.type==='ws'&&wsMap[p.id]) wsMap[p.id].close(); });
    state.pages.forEach(function(p){ if(p.id!==id&&p.type==='ws'&&wsNative[p.id]){wsNativeStopPoll(p.id);invoke('ws_close',{id:wsNative[p.id].id});wsNative[p.id]=null;} });
    state.pages = state.pages.filter(function(p){return p.id===id;});
    state.activeId = id;
    render();
  }

  function render() {
    document.body.dataset.theme=state.theme;
    document.documentElement.style.setProperty('font-size', (localStorage.getItem('fontSize')||13)+'px', 'important');
    document.documentElement.style.setProperty('font-family', '"'+(localStorage.getItem('fontFamily')||'Microsoft YaHei UI')+'","Microsoft YaHei UI","Segoe UI",Arial,sans-serif', 'important');
    renderTools();
    renderTabs();
    renderPage();
    // 更新底部按钮文字（语言切换时）
    var sb=$('openSettings'), ab=$('openAbout');
    if(sb)sb.childNodes[sb.childNodes.length-1].textContent=tt('设置');
    if(ab)ab.childNodes[ab.childNodes.length-1].textContent=tt('关于');
    // 按主题切换底部按钮图标（白色主题用 _white 版）
    if(sb){var sImg=sb.querySelector('img'); if(sImg)sImg.src='icons/settings'+navIconSuffix()+'.svg';}
    if(ab){var aImg=ab.querySelector('img'); if(aImg)aImg.src='icons/about'+navIconSuffix()+'.svg';}
    // 更新窗口标题 & 进程右键菜单
    var an=document.querySelector('.app-name'); if(an)an.textContent=tt('Jade 编程助手 version 1.3');
    document.title=tt('Jade 编程助手 version 1.3');
    var pk=$('procKillAction'); if(pk)pk.textContent=tt('关闭进程');
    var po=$('procOpenAction'); if(po)po.textContent=tt('定位文件夹');
    var pi=$('procIconAction'); if(pi)pi.textContent=tt('提取图标保存');
    var ph=$('procHexPidAction'); if(ph)ph.textContent=tt('显示16进制PID');
    var pc=document.querySelector('#procContextMenu [data-action="proc-copy"]'); if(pc)pc.textContent=tt('复制信息');
    // 更新标签页右键菜单
    var co=document.querySelector('#contextMenu [data-action="close-others"]'); if(co)co.textContent=tt('关闭其他标签');
    var ca=document.querySelector('#contextMenu [data-action="close-all-tabs"]'); if(ca)ca.textContent=tt('关闭全部标签');
    var cn=document.querySelector('#contextMenu [data-action="new-instance"]'); if(cn)cn.textContent=tt('新建同类页面');
    var cd=document.querySelector('#contextMenu [data-action="duplicate"]'); if(cd)cd.textContent=tt('复制当前页面');
    var ccl=document.querySelector('#contextMenu [data-action="close-instance"]'); if(ccl)ccl.textContent=tt('关闭页面');
    var cpy=document.querySelector('#contextMenu [data-action="proc-copy"]'); if(cpy)cpy.textContent=tt('复制信息');
    // 重新翻译所有页面标题（语言切换时 toolDefs 的值不变，需重新求值）
    state.pages.forEach(function(p){
      var def=toolDefs[p.type]||systemDefs[p.type];
      if(systemDefs[p.type]){p.title=tt(def._n);}
      else{var same=state.pages.filter(function(pp){return pp.type===p.type;}); var idx=same.indexOf(p)+1; p.title=tt(def._n)+' '+idx;}
    });
  }

  // 白色主题用 _white 图标，其它主题(glass/black)用普通版
  function navIconSuffix(){ return state.theme==='white' ? '_white' : ''; }
  function renderTools() {
    var LANG_MAP = { http:['HTTP 请求', 'POST / GET / cURL'], ws:['WebSocket', 'WS / WSS'], encoding:['编码转换', 'UTF-8 / GBK / Big5'], json:['JSON 解析', '格式化 / 压缩 / 路径'], calculator:['程序猿计算器', 'DEC / HEX / BIN'], msaa:['MSAA 解析', '窗口可访问性'], process:['进程管理', 'Process'], color:['窗口取色', 'Color Picker'], winspy:['窗口 SPY', 'Window Spy'], proxy:['代理 IP', 'Proxy Check'], regex:['正则调试', 'RegExp'], jspatch:['JS调试器', '补环境 / 沙箱'], settings:['设置', '主题 / 字体 / 启动'], about:['关于', JADE.d('JPJ:eJa:JnJu:JtJ J:SJoJfJt')] };
    var html=Object.keys(toolDefs).map(function(type){
      var def=toolDefs[type];
      var count=state.pages.filter(function(p){return p.type===type;}).length;
      var isActive=activePage()&&activePage().type===type;
      var keys = LANG_MAP[type] || [def._n, def._k];
      return '<button class="tool-item'+(isActive?' active':'')+'" data-type="'+type+'"'+'>'+
        '<span class="tool-icon"><img class="tool-icon-img" src="icons/'+def.icon+navIconSuffix()+'.svg" alt=""></span>'+
        '<span class="tool-name">'+tt(keys[0])+'</span>'+
        '<span class="tool-count">'+count+'</span></button>';
    }).join('');
    $('toolList').innerHTML=html;
  }

  function renderTabs() {
    $('tabs').innerHTML=state.pages.map(function(p){
      return'<button class="tab'+(p.id===state.activeId?' active':'')+'" data-id="'+p.id+'" title="右键关闭或复制"><span class="tab-title">'+esc(p.title)+'</span></button>';
    }).join('');
  }

  function renderHero(page, actions) {
    $('activeSubtitle').textContent=JADE.d('JPJ:eJa:JnJu:JtJ J:SJoJfJt:J J·J JQJQ:J J2J4J5J8J6J7');
    return'<div class="hero-card"><div><h1 class="page-title">'+esc(page.title)+'</h1><p class="page-desc">'+esc(tt((toolDefs[page.type]||systemDefs[page.type]||{})._d||''))+'</p></div><div class="hero-actions">'+(actions||'')+'</div></div>';
  }
  window.renderHero = renderHero;

  function renderPage() {
    var page=activePage();
    if(!page)return;
    if(page.type==='http')renderHttp(page);
    if(page.type==='ws')renderWs(page);
    if(page.type==='encoding')renderEncoding(page);
    if(page.type==='json')renderJson(page);
    if(page.type==='calculator')renderCalculator(page);
    if(page.type==='msaa')renderMsaa(page);
    if(page.type==='process')renderProcess(page);
    if(page.type==='color')renderColor(page);
    if(page.type==='winspy')renderWinSpy(page);
    if(page.type==='proxy')renderProxy(page);
    if(page.type==='regex')renderRegex(page);
    if(page.type==='jspatch')renderJSPatch(page);
    if(page.type==='yolo'&&window.YOLO)YOLO.render(page);
    if(page.type==='settings')renderSettings(page);
    if(page.type==='about')renderAbout(page);
  }

  // ═══════════════════════ JSPATCH ═══════════════════════
  // 轻量级 JS 语法高亮分词器
  var JS_KW={'break':1,'case':1,'catch':1,'class':1,'const':1,'continue':1,'debugger':1,'default':1,'delete':1,'do':1,'else':1,'export':1,'extends':1,'finally':1,'for':1,'function':1,'if':1,'import':1,'in':1,'instanceof':1,'let':1,'new':1,'of':1,'return':1,'static':1,'super':1,'switch':1,'this':1,'throw':1,'try':1,'typeof':1,'var':1,'void':1,'while':1,'with':1,'yield':1,'async':1,'await':1,'from':1,'as':1};
  var JS_BI={'console':1,'window':1,'document':1,'Math':1,'JSON':1,'Promise':1,'Array':1,'Object':1,'String':1,'Number':1,'Boolean':1,'Date':1,'RegExp':1,'Error':1,'Map':1,'Set':1,'WeakMap':1,'WeakSet':1,'Symbol':1,'Proxy':1,'Reflect':1,'Intl':1,'parseInt':1,'parseFloat':1,'isNaN':1,'isFinite':1,'eval':1,'undefined':1,'null':1,'true':1,'false':1,'NaN':1,'Infinity':1,'BigInt':1,'globalThis':1};

  function _esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function highlightJS(raw){
    var i=0, out='';
    while(i<raw.length){
      var c=raw[i];
      // 行注释 //
      if(c==='/'&&raw[i+1]==='/'){
        var e=raw.indexOf('\n',i); if(e===-1)e=raw.length;
        out+='<span class="hl-comment">'+_esc(raw.slice(i,e))+'</span>';
        i=e; continue;
      }
      // 块注释 /* */
      if(c==='/'&&raw[i+1]==='*'){
        var e=raw.indexOf('*/',i+2); if(e===-1)e=raw.length; else e+=2;
        out+='<span class="hl-comment">'+_esc(raw.slice(i,e))+'</span>';
        i=e; continue;
      }
      // 模板字符串 `...`
      if(c==='`'){
        var j=i+1;
        while(j<raw.length){ if(raw[j]==='\\'){j+=2;continue;} if(raw[j]==='`'){j++;break;} j++; }
        out+='<span class="hl-string">'+_esc(raw.slice(i,j))+'</span>';
        i=j; continue;
      }
      // 双引号字符串
      if(c==='"'){
        var j=i+1;
        while(j<raw.length){ if(raw[j]==='\\'){j+=2;continue;} if(raw[j]==='"'){j++;break;} j++; }
        out+='<span class="hl-string">'+_esc(raw.slice(i,j))+'</span>';
        i=j; continue;
      }
      // 单引号字符串
      if(c==="'"){
        var j=i+1;
        while(j<raw.length){ if(raw[j]==='\\'){j+=2;continue;} if(raw[j]==="'"){j++;break;} j++; }
        out+='<span class="hl-string">'+_esc(raw.slice(i,j))+'</span>';
        i=j; continue;
      }
      // 数字
      if(/\d/.test(c)||(c==='.'&&i+1<raw.length&&/\d/.test(raw[i+1]))){
        var j=i;
        while(j<raw.length&&/[\w.]/.test(raw[j]))j++;
        var num=raw.slice(i,j);
        if(/^(?:0[xXbBoO][\da-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)$/.test(num)){
          out+='<span class="hl-number">'+num+'</span>';
          i=j; continue;
        }
        out+=_esc(c); i++; continue;
      }
      // 标识符/关键字
      if(/[a-zA-Z_$]/.test(c)){
        var j=i;
        while(j<raw.length&&/[\w$]/.test(raw[j]))j++;
        var w=raw.slice(i,j);
        var k=j; while(k<raw.length&&/\s/.test(raw[k]))k++;
        var isFn=k<raw.length&&raw[k]==='(';
        if(isFn) out+='<span class="hl-fn">'+w+'</span>';
        else if(JS_KW[w]) out+='<span class="hl-keyword">'+w+'</span>';
        else if(JS_BI[w]) out+='<span class="hl-builtin">'+w+'</span>';
        else out+=_esc(w);
        i=j; continue;
      }
      out+=_esc(c); i++;
    }
    return out;
  }

  function syncJSHighlight(){
    var ta=$('jspatchCode'), pre=$('jspatchHighlight');
    if(!ta||!pre)return;
    pre.innerHTML='<code>'+highlightJS(ta.value)+'\n</code>';
    pre.scrollTop=ta.scrollTop; pre.scrollLeft=ta.scrollLeft;
  }

  // 简单 JS 格式化（缩进换行）
  function _jsBeautify(code){
    var out='', indent=0, i=0;
    function _push(c){ out+=c; }
    function _newline(){ out+='\n'+'  '.repeat(Math.max(0,indent)); }
    while(i<code.length){
      var c=code[i];
      // 跳过字符串内容
      if(c==='"'||c==="'"||c==='`'){
        var q=c, j=i+1;
        _push(c);
        while(j<code.length){ _push(code[j]); if(code[j]==='\\'){j++;_push(code[j]);} else if(code[j]===q){i=j+1;break;} j++; }
        if(j>=code.length)i=j;
        continue;
      }
      // 跳过注释
      if(c==='/'&&code[i+1]==='/'){
        while(i<code.length&&code[i]!=='\n')i++;
        if(i<code.length&&code[i]==='\n'){_newline();i++;}continue;
      }
      if(c==='/'&&code[i+1]==='*'){
        var e=code.indexOf('*/',i+2);
        out+=code.slice(i,(e===-1?code.length:e+2));i=(e===-1?code.length:e+2);continue;
      }
      if(c==='{'){
        var pre=code.slice(Math.max(0,i-20),i).trimEnd();
        if(pre&&pre[pre.length-1]!=='\n')_newline();
        _push('{');_newline();indent++;i++;
      }else if(c==='}'){
        indent=Math.max(0,indent-1);_newline();_push('}');_newline();i++;
      }else if(c===';'){
        _push(';');_newline();i++;
      }else if(c==='\n'||c==='\r'){
        i++; // skip existing newlines
      }else{
        _push(c);i++;
      }
    }
    return out.trim();
  }
  // JS 压缩（去空格注释）
  function _jsMinify(code){
    var raw='',i=0;
    while(i<code.length){
      var c=code[i];
      if(c==='"'||c==="'"||c==='`'){var q=c,j=i+1;raw+=c;while(j<code.length){raw+=code[j];if(code[j]==='\\'){j++;raw+=code[j];}else if(code[j]===q){raw+=code[j];i=j+1;break;}j++;}if(j>=code.length)i=j;continue;}
      if(c==='/'&&code[i+1]==='/'){while(i<code.length&&code[i]!=='\n')i++;continue;}
      if(c==='/'&&code[i+1]==='*'){var e=code.indexOf('*/',i+2);i=(e===-1?code.length:e+2);continue;}
      raw+=c;i++;
    }
    raw=raw.replace(/[ \t]+/g,' ').replace(/\n\s*/g,'\n').replace(/;}/g,'}').trim();
    raw=raw.replace(/\s*([{}();:,\[\]])\s*/g,'$1');
    raw=raw.replace(/\}(else|while|catch|finally)\b/g,'}$1');
    return raw.replace(/\n+/g,'');
  }
  function _applyJSTransform(fn){
    var ta=$('jspatchCode'); if(!ta)return;
    ta.value=fn(ta.value); syncJSHighlight();
  }

  function renderJSPatch(page){ var d=page.data;
    $('page').innerHTML='<div class="tool-page">'+renderHero(page,
      '<button class="btn primary" id="runJSPatch">▶ '+tt('运行')+'</button><button class="btn danger" id="stopJSPatch" style="display:none">⏹ '+tt('停止')+'</button><button class="btn small" id="beautifyJS">🎨 '+tt('格式化')+'</button><button class="btn small" id="minifyJS">🗜️ '+tt('压缩')+'</button><button class="btn small" id="clearJSPatch">'+tt('清空输出')+'</button><button class="btn small" id="detectJSPatch">🔍 '+tt('检测环境')+'</button>')+
      '<div class="jspatch-layout"><div class="panel-card jspatch-editor"><div class="panel-title">Code Editor</div>'+
      '<div class="jspatch-editor-wrap"><textarea id="jspatchCode" class="mono jspatch-textarea" spellcheck="false">'+esc(d.code)+'</textarea><pre id="jspatchHighlight" class="jspatch-highlight" aria-hidden="true"><code></code></pre></div></div>'+
      '<div class="panel-card jspatch-output"><div class="panel-title">Console Output</div>'+
      '<pre id="jspatchOut" class="result-box" style="height:400px;min-height:400px;max-height:400px;overflow:auto">'+esc(d.output||'等待运行...')+'</pre>'+
      '<div class="panel-title" style="margin-top:8px">Missing Globals <button class="btn tiny-btn" id="patchJSPatchGlobals" style="display:none;margin-left:10px;vertical-align:middle">🔧 '+tt('一键补环境')+'</button></div>'+
      '<pre id="jspatchMissing" class="result-box" style="min-height:120px;max-height:180px;overflow:auto;color:var(--danger)">'+(d.missing&&d.missing.length?formatJSPatchMissing(d.missing):tt('暂无'))+'</pre></div></div></div>';
    // 语法高亮初始化
    var ta=$('jspatchCode'); if(ta){
      syncJSHighlight();
      ta.addEventListener('input',syncJSHighlight);
      ta.addEventListener('scroll',function(){var pre=$('jspatchHighlight');if(pre){pre.scrollTop=ta.scrollTop;pre.scrollLeft=ta.scrollLeft;}});
      ta.addEventListener('keydown',function(e){
        if(e.key==='Tab'){e.preventDefault();var s=ta.selectionStart,val=ta.value;ta.value=val.slice(0,s)+'  '+val.slice(ta.selectionEnd);ta.selectionStart=ta.selectionEnd=s+2;syncJSHighlight();}
        if(e.key==='Enter'){setTimeout(syncJSHighlight,0);}
      });
    }
  }
  function formatJSPatchMissing(items){
    return (items||[]).map(function(item){
      var parts=String(item).split(':');
      var name=parts.shift().trim();
      var status=parts.join(':').trim();
      var label=status==='undefined'?tt('未定义'):status==='inaccessible'?tt('无法访问'):status;
      return name+'：'+label;
    }).join('\n');
  }
  var _jsRunId=0, _jsTimer=null; // 递增运行ID+旧定时器，防止旧异步回调污染新运行
  function runJSPatch(page){
    if(_jsTimer){clearTimeout(_jsTimer);_jsTimer=null;}
    var runBtn=$('runJSPatch'), stopBtn=$('stopJSPatch');
    if(runBtn)runBtn.style.display='none';
    if(stopBtn)stopBtn.style.display='';
    var runId=++_jsRunId;
    var code=$('jspatchCode'); if(!code)return; var src=code.value; page.data.code=src;
    var out=$('jspatchOut'), miss=$('jspatchMissing');
    if(out)out.textContent='执行中...\n';
    // 收集console.log输出
    var logs=[]; var oldLog=console.log; var oldErr=console.error; var resolved=false;
    function _fmt(a){
      if(a===null)return'null';
      if(a===undefined)return'undefined';
      if(typeof a==='function')return'[Function]';
      if(typeof a==='object'){try{return JSON.stringify(a);}catch(e){return'[Object]';}}
      return String(a);
    }
    console.log=function(){if(_jsRunId===runId){logs.push(Array.prototype.slice.call(arguments).map(_fmt).join(' '));} oldLog.apply(console,arguments);};
    console.error=function(){if(_jsRunId===runId){logs.push('ERR: '+Array.prototype.slice.call(arguments).map(_fmt).join(' '));} oldErr.apply(console,arguments);};

    function finalize(){
      if(resolved)return; resolved=true;
      if(_jsRunId!==runId)return; // 过期运行不渲染
      console.log=oldLog; console.error=oldErr;
      if(runBtn)runBtn.style.display='';
      if(stopBtn)stopBtn.style.display='none';
      if(out)out.textContent=page.data.output;
      if(miss&&page.data.missing)miss.textContent=page.data.missing.join('\n');
      code.value=src;
    }

    function handleError(e){
      page.data.output=logs.join('\n')+'\n✖ '+e.message;
      var errMsg=e.message||'';
      var refMatch=errMsg.match(/is not defined$/)?errMsg:null;
      if(refMatch){
        var missingName=errMsg.replace(' is not defined','');
        if(!page.data.missing)page.data.missing=[];
        if(page.data.missing.indexOf(missingName)<0)page.data.missing.push(missingName+': '+errMsg);
      }
      finalize();
    }

    try{
      var result=eval(src);
      // 检测是否为 Promise（支持 async/await 场景）
      if(result && typeof result.then==='function'){
        _jsTimer=setTimeout(function(){
          _jsTimer=null;
          logs.push('⚠ 异步执行超时（5秒），部分回调可能未完成');
          page.data.output=logs.join('\n');
          finalize();
        }, 5000);
        result.then(function(v){
          if(v!==undefined){
            try{logs.push('→ '+JSON.stringify(v));}
            catch(e){logs.push('→ [不可序列化的返回值]');}
          }
          // 主 Promise 完成后再给 500ms 宽限期，等其余异步回调收尾
          _jsTimer=setTimeout(function(){
            _jsTimer=null;
            page.data.output=logs.join('\n')||'执行完成（无输出）';
            finalize();
          }, 500);
        }).catch(function(e){
          clearTimeout(_jsTimer); _jsTimer=null;
          handleError(e);
        });
        return; // 异步等待，暂不 finalize
      }
      // 同步返回值
      if(result!==undefined){
        try{logs.push('→ '+JSON.stringify(result));}
        catch(e){logs.push('→ [返回值]');}
      }
      page.data.output=logs.join('\n')||'执行完成（无输出）';
      // 即使同步代码也可能含 setTimeout/Promise，留 300ms 宽限期捕获异步日志
      _jsTimer=setTimeout(function(){
        _jsTimer=null;
        page.data.output=logs.join('\n')||'执行完成（无输出）';
        finalize();
      }, 300);
      return;
    }catch(e){
      handleError(e);
    }
  }
  function detectJSPatchGlobals(page){
    var code=$('jspatchCode'); if(!code)return; var src=code.value; page.data.code=src;
    page.data.missing=[]; page.data.patched={};
    // 去掉字符串和注释，避免将字符串内容误判为全局变量
    var cleanSrc=src;
    cleanSrc=cleanSrc.replace(/\/\/.*$/gm,' ');
    cleanSrc=cleanSrc.replace(/\/\*[\s\S]*?\*\//g,' ');
    cleanSrc=cleanSrc.replace(/`(?:[^`\\]|\\.)*`/g,'""');
    cleanSrc=cleanSrc.replace(/"(?:[^"\\]|\\.)*"/g,'""');
    cleanSrc=cleanSrc.replace(/'(?:[^'\\]|\\.)*'/g,"''");
    // 去掉常见“不是全局引用”的位置：对象键、对象方法名、标签名。
    cleanSrc=cleanSrc.replace(/(^|[,{;\n]\s*)([a-zA-Z_$][\w$]*)\s*:/g,function(all,prefix){return prefix+' ';});
    cleanSrc=cleanSrc.replace(/(^|[,{;\n]\s*)([a-zA-Z_$][\w$]*)\s*\(/g,function(all,prefix,name){
      var before=cleanSrc.slice(0, Math.max(0, cleanSrc.indexOf(all))).trimEnd();
      return prefix+' function ';
    });
    // 收集代码中声明的局部变量，避免误报
    var localNames={}, m;
    // var/let/const 声明: let x = 1, {y, z} = obj, [a, ...b] = arr
    var declRe=/(?:^|[;\n])\s*(?:var|let|const)\s+([^=;]+?)(?:[=;]|$)/gm;
    while((m=declRe.exec(cleanSrc))!==null){
      m[1].replace(/[\[\]{}]/g,' ').split(',').forEach(function(n){
        var nm=n.split(':')[0].trim().split(/\s+/)[0];
        if(/^[a-zA-Z_$][\w$]*$/.test(nm))localNames[nm]=1;
      });
    }
    // function 声明: function foo(...)
    var fnRe=/\bfunction\s+([a-zA-Z_$][\w$]*)\s*\(/g;
    while((m=fnRe.exec(cleanSrc))!==null)localNames[m[1]]=1;
    // class 声明
    var clsRe=/\bclass\s+([a-zA-Z_$][\w$]*)/g;
    while((m=clsRe.exec(cleanSrc))!==null)localNames[m[1]]=1;
    // catch 参数
    var catchRe=/\bcatch\s*\(\s*([a-zA-Z_$][\w$]*)\s*\)/g;
    while((m=catchRe.exec(cleanSrc))!==null)localNames[m[1]]=1;
    // 函数/箭头参数: (a, b) => 或 function(a, b) {
    var parRe=/(?:function\s*\w*\s*|=>?\s*)\(([^)]*)\)/g;
    while((m=parRe.exec(cleanSrc))!==null){
      m[1].replace(/[\[\]{}]/g,' ').split(',').forEach(function(p){
        var nm=p.replace(/[=].*$/,'').trim().split(/\s+/)[0];
        if(/^[a-zA-Z_$][\w$]*$/.test(nm))localNames[nm]=1;
      });
    }
    // 独立箭头函数参数: (a, b) => 或 const x = (a, b) =>
    var arrowRe=/\(([^)]*)\)\s*=>/g;
    while((m=arrowRe.exec(cleanSrc))!==null){
      m[1].replace(/[\[\]{}]/g,' ').split(',').forEach(function(p){
        var nm=p.replace(/[=].*$/,'').trim().split(/\s+/)[0];
        if(/^[a-zA-Z_$][\w$]*$/.test(nm))localNames[nm]=1;
      });
    }
    // 单参数箭头函数: x =>
    var singleArrowRe=/(^|[^\w$])([a-zA-Z_$][\w$]*)\s*=>/g;
    while((m=singleArrowRe.exec(cleanSrc))!==null)localNames[m[2]]=1;
    // for...of / for...in 左侧变量
    var forRe=/\bfor\s*\(\s*(?:var|let|const)?\s*([a-zA-Z_$][\w$]*)\s+(?:in|of)\b/g;
    while((m=forRe.exec(cleanSrc))!==null)localNames[m[1]]=1;
    // 排除对象属性/方法调用模式: obj.prop / .prop( → "prop"不是全局变量
    var dotRe=/\.(\w+)\b/g;
    while((m=dotRe.exec(cleanSrc))!==null)localNames[m[1]]=1;
    // 排除成员访问中的计算属性常量/标识符: obj[key] 保守地不当成全局
    var bracketRe=/\[\s*([a-zA-Z_$][\w$]*)\s*\]/g;
    while((m=bracketRe.exec(cleanSrc))!==null)localNames[m[1]]=1;
    // 使用正则粗略检测未定义的全局引用
    var globals=cleanSrc.match(/\b([a-zA-Z_$][\w$]*)\b/g)||[];
    var seen={}; var builtins={
      'window':1,'document':1,'console':1,'arguments':1,'this':1,'undefined':1,'null':1,'true':1,'false':1,'NaN':1,'Infinity':1,
      'eval':1,'parseInt':1,'parseFloat':1,'isNaN':1,'isFinite':1,'decodeURI':1,'decodeURIComponent':1,'encodeURI':1,'encodeURIComponent':1,'escape':1,'unescape':1,
      'Array':1,'Object':1,'String':1,'Number':1,'Boolean':1,'Date':1,'RegExp':1,'Error':1,'Math':1,'JSON':1,'Promise':1,'Symbol':1,
      'Map':1,'Set':1,'WeakMap':1,'WeakSet':1,'Int8Array':1,'Uint8Array':1,'Int16Array':1,'Uint16Array':1,'Int32Array':1,'Uint32Array':1,
      'Float32Array':1,'Float64Array':1,'BigInt':1,'Reflect':1,'Proxy':1,'Intl':1,'globalThis':1,
      'AbortController':1,'AbortSignal':1,'URL':1,'URLSearchParams':1,'TextDecoder':1,'TextEncoder':1,'atob':1,'btoa':1,
      'Blob':1,'File':1,'FileReader':1,'FormData':1,'fetch':1,'Response':1,'Request':1,'Headers':1,'crypto':1,
      'setTimeout':1,'setInterval':1,'clearTimeout':1,'clearInterval':1,'requestAnimationFrame':1,'cancelAnimationFrame':1
    };
    var kwSet={'var':1,'let':1,'const':1,'function':1,'if':1,'else':1,'for':1,'while':1,'do':1,'switch':1,'case':1,'return':1,'new':1,'typeof':1,'instanceof':1,'in':1,'of':1,'class':1,'extends':1,'super':1,'import':1,'export':1,'default':1,'try':1,'catch':1,'finally':1,'throw':1,'break':1,'continue':1,'debugger':1,'void':1,'delete':1,'with':1,'yield':1,'async':1,'await':1,'from':1,'as':1,'static':1,'enum':1,'implements':1,'interface':1,'package':1,'private':1,'protected':1,'public':1,'get':1,'set':1,'target':1,'arguments':1};
    var reservedDecl={'static':1,'enum':1,'implements':1,'interface':1,'package':1,'private':1,'protected':1,'public':1,'get':1,'set':1,'var':1,'let':1,'const':1,'function':1,'class':1,'return':1,'new':1,'delete':1,'typeof':1,'instanceof':1,'void':1,'yield':1,'await':1,'async':1,'import':1,'export':1,'default':1};
    globals.forEach(function(g){
      if(!seen[g]&&!builtins[g]&&!localNames[g]&&!kwSet[g]&&!/^\d/.test(g)&&g.length>1){
        seen[g]=1;
        try{
          if(typeof globalThis[g]==='undefined')page.data.missing.push(g+': undefined');
        }catch(ex){
          page.data.missing.push(g+': inaccessible');
        }
      }
    });
    var miss=$('jspatchMissing'); if(miss)miss.textContent=page.data.missing.length?formatJSPatchMissing(page.data.missing):tt('未检测到缺失变量');
    var patchBtn=$('patchJSPatchGlobals'); if(patchBtn)patchBtn.style.display=page.data.missing.length?'':'none';
  }
  // HTTP functions now in modules/http.js (renderHttp, sendHttp, syncHttp, importCurl, genHttpCodeStr, etc.)

    // Encoding now in modules/encoding.js

  function convertOneEncoding(page, target) {
    var transform=transforms.find(function(item){return item.id===target;});
    if(transform&&transform.type!=='encoding')return convertText(page.data.input,target).then(function(output){return{ok:true,detected:'text',output:output};});
    return invoke('convert_encoding',{input:page.data.input,target:target}).then(function(res){
      var data=typeof res==='string'?JSON.parse(res):res;
      if(!data.ok)throw new Error(data.error||'failed');
      return data;
    });
  }

  async function runAllEncodingTransforms(page) {
    page.data.input=$('encodingInput').value;
    page.data.allResult='转换中...';
    renderEncoding(page);
    var lines=[];
    for(var i=0;i<transforms.length;i++){
      var item=transforms[i];
      try{
        var data=await convertOneEncoding(page,item.id);
        var output=item.id==='hex-decode'?hexDecodePreview(page.data.input):String((data&&(data.output||data.result||data.text))||'').replace(/[\r\n]+/g,' ');
        var preview=output.slice(0,90)+(output.length>90?'...':'');
        lines.push((transformZhNames[item.id]||item.name)+'：\t'+preview);
      }catch(error){
        lines.push((transformZhNames[item.id]||item.name)+'：\t错误：'+String(error.message||error).slice(0,60));
      }
      page.data.allResult=lines.join('\n');
      renderEncoding(page);
    }
  }

  // ═══════════════════════ JSON REDESIGNED ═══════════════════════
  function renderJson(page) { var d=page.data; var curLib=currentLib(d);
    var libTabs=(JSON_LIBS[d.codeLang]||[]).map(function(l){return '<button class="btn small'+(curLib===l.id?' active':'')+'" data-code-lib="'+l.id+'">'+esc(l.name)+'</button>';}).join('');
    $('page').innerHTML='<div class="tool-page">'+renderHero(page,
      '<button class="btn primary" id="parseJson">'+tt('解析')+'</button><button class="btn small" id="formatJson">'+tt('格式化')+'</button><button class="btn small" id="minifyJson">'+tt('压缩')+'</button><button class="btn small" id="copyJson">'+tt('复制结果')+'</button><button class="btn small" id="jsonDiff">Diff</button>')+
      '<div class="json-workbench">'+
      '<div class="panel-card json-input-card"><div class="panel-title">JSON Input</div><textarea id="jsonInput" class="mono" style="min-height:450px">'+esc(d.input)+'</textarea></div>'+
      '<div class="panel-card json-tree-card"><div class="panel-title">Parse Tree</div><div class="json-tree pro-tree" id="jsonTree">'+renderJsonTree(d)+'</div>'+
      '<div class="json-path-footer"><span class="path-label">路径</span><span class="path-value" id="jsonPathDisplay">'+esc(d.selectedPath||'$')+'</span></div></div>'+
      '<div class="panel-card json-output-card"><div class="panel-title">Formatted Output</div><pre class="result-box" id="jsonOutput" style="min-height:160px">'+esc(d.output)+'</pre></div>'+
      '<div class="panel-card json-code-card"><div class="panel-title">'+tt('代码生成')+'</div><div class="code-tabs"><button class="btn small'+(d.codeLang==='cpp'?' active':'')+'" data-code-lang="cpp"><img src="2.ico" style="width:14px;height:14px;margin-right:3px;vertical-align:middle" onerror="this.style.display=\'none\'">C++</button><button class="btn small'+(d.codeLang==='py'?' active':'')+'" data-code-lang="py"><img src="python.svg" style="width:14px;height:14px;margin-right:3px;vertical-align:middle" onerror="this.style.display=\'none\'"> PY</button><button class="btn small'+(d.codeLang==='js'?' active':'')+'" data-code-lang="js"><img src="folder_type_js.svg" style="width:17px;height:17px;margin-right:3px;vertical-align:middle" onerror="this.style.display=\'none\'"> JS</button><button class="btn small'+(d.codeLang==='go'?' active':'')+'" data-code-lang="go"><img src="go.svg" style="width:14px;height:14px;margin-right:3px;vertical-align:middle" onerror="this.style.display=\'none\'"> Go</button><button class="btn small'+(d.codeLang==='rs'?' active':'')+'" data-code-lang="rs"><img src="rust.svg" style="width:14px;height:14px;margin-right:3px;vertical-align:middle" onerror="this.style.display=\'none\'"> Rust</button><button class="btn small'+(d.codeLang==='e'?' active':'')+'" data-code-lang="e"><img src="E.svg" style="width:14px;height:14px;margin-right:3px;vertical-align:middle" onerror="this.style.display=\'none\'">'+tt('易语言')+'</button></div><div class="panel-subtitle" style="margin-top:8px;opacity:.65;font-size:11px">'+tt('JSON 库')+'</div><div class="code-tabs lib-tabs" style="margin-top:4px">'+libTabs+'</div><button class="btn primary" id="showZyCode" style="width:100%;margin-top:8px;min-height:38px;font-size:13px;font-weight:700">📋 '+tt('查看并复制代码')+'</button></div>'+
      '</div></div>';
  }

  function walkJson(value,path,out,depth){
    var type=Array.isArray(value)?'array':value===null?'null':typeof value;
    out.push({path:path,key:path.split(/[.[\]]/).filter(Boolean).pop()||'$',type:type,value:value,depth:depth||0});
    if(value&&typeof value==='object')Object.keys(value).forEach(function(k){walkJson(value[k],path+(Array.isArray(value)?'['+k+']':(path==='$'?'.':'.')+k),out,(depth||0)+1);});
  }
  function renderJsonTree(d){
    if(!d.tree||!d.tree.length)return'<div class="empty">点击"解析"生成树。</div>';
    return d.tree.map(function(n,i){
      var preview=n.value&&typeof n.value==='object'?n.type:JSON.stringify(n.value);
      return'<button class="tree-node'+(d.selectedPath===n.path?' active':'')+'" data-tree-index="'+i+'" style="padding-left:'+(8+n.depth*14)+'px"><span class="tree-key">'+esc(n.key)+'</span> <span class="tree-type">'+esc(n.type)+'</span> <span class="tree-value">'+esc(preview)+'</span></button>';
    }).join('');
  }
  function parseJson(page,minify){
    try{var obj=JSON.parse($('jsonInput').value);page.data.input=$('jsonInput').value;page.data.output=JSON.stringify(obj,null,minify?0:2);var nodes=[];walkJson(obj,'$',nodes,0);page.data.tree=nodes;page.data.selectedPath=nodes[0]?nodes[0].path:'$';page.data.code=makeZyCode(page.data.selectedPath,page.data.codeLang,currentLib(page.data));}catch(e){page.data.output='JSON 错误：'+e.message;page.data.tree=[];page.data.code='';}
    renderJson(page);
  }

  // 各语言可选的主流 JSON 库（每种语言最多 3 个，第一个为默认）
  var JSON_LIBS={
    cpp:[{id:'nlohmann',name:'nlohmann/json'},{id:'yyjson',name:'yyjson'},{id:'simdjson',name:'simdjson'}],
    py:[{id:'json',name:'json (标准库)'},{id:'orjson',name:'orjson'},{id:'ujson',name:'ujson'}],
    js:[{id:'native',name:'原生 JSON'},{id:'lodash',name:'lodash'}],
    go:[{id:'std',name:'encoding/json'},{id:'gjson',name:'gjson'},{id:'sonic',name:'sonic'}],
    rs:[{id:'serde',name:'serde_json'},{id:'simd',name:'simd-json'}],
    e:[{id:'zyjson',name:'zyJson'},{id:'jingyi',name:'精易模块'}]
  };
  function currentLib(d){var ls=JSON_LIBS[d.codeLang]||[];var pick=d.codeLibs&&d.codeLibs[d.codeLang];if(pick&&ls.some(function(l){return l.id===pick;}))return pick;return ls[0]?ls[0].id:'';}
  function jsonParts(path){var clean=path.replace(/^\$\.?/,'');return clean?clean.replace(/\[(\d+)\]/g,'.$1').split('.').filter(Boolean):[];}
  function jIsIdx(p){return/^\d+$/.test(p);}
  function jBracket(parts){return parts.map(function(p){return jIsIdx(p)?'['+p+']':'["'+p+'"]';}).join('');} // ["a"]["b"][0]
  function jPointer(parts){return parts.length?'/'+parts.join('/'):'';}                                       // /a/b/0 (RFC6901)
  function jDot(parts){return parts.join('.');}                                                                // a.b.0 (gjson)
  function jLodash(parts){return parts.map(function(p,i){return jIsIdx(p)?'['+p+']':(i?'.':'')+p;}).join('');} // a.b[0]
  function jJsAccess(parts){return parts.map(function(p){return jIsIdx(p)?'['+p+']':'.'+p;}).join('');}        // .a.b[0]
  function jGoStd(parts,path){
    var rootArr=parts.length&&jIsIdx(parts[0]);
    var decl=rootArr?'var data []interface{}':'var data map[string]interface{}';
    var expr='data';
    parts.forEach(function(p,i){
      if(i===0)expr+=jIsIdx(p)?'['+p+']':'["'+p+'"]';
      else expr+=jIsIdx(p)?'.([]interface{})['+p+']':'.(map[string]interface{})["'+p+'"]';
    });
    return'import "encoding/json"\n\n'+decl+'\njson.Unmarshal([]byte(jsonText), &data)\n// 访问路径: '+path+'\nvalue := '+expr;
  }

  function makeZyCode(path, lang, lib) {
    var parts=jsonParts(path), br=jBracket(parts), ptr=jPointer(parts), cmt='// 访问路径: '+path+'\n';
    var libs=JSON_LIBS[lang]||[];
    if(!lib||!libs.some(function(l){return l.id===lib;}))lib=libs[0]?libs[0].id:'';
    if(lang==='cpp'){
      if(lib==='yyjson')return'#include "yyjson.h"\n\nyyjson_doc *doc = yyjson_read(jsonText, len, 0);\nyyjson_val *root = yyjson_doc_get_root(doc);\n'+cmt+'yyjson_val *value = yyjson_ptr_get(root, "'+ptr+'");\n// ... 使用 value ...\nyyjson_doc_free(doc);';
      if(lib==='simdjson')return'#include "simdjson.h"\nusing namespace simdjson;\n\nondemand::parser parser;\npadded_string json = padded_string(jsonText);\nondemand::document doc = parser.iterate(json);\n'+cmt+'auto value = doc.at_pointer("'+ptr+'");';
      return'#include <nlohmann/json.hpp>\nusing json = nlohmann::json;\n\njson j = json::parse(jsonText);\n'+cmt+'auto value = j'+br+';';
    }
    if(lang==='py'){
      var mod=lib==='orjson'?'orjson':lib==='ujson'?'ujson':'json';
      return'import '+mod+'\ndata = '+mod+'.loads(json_text)\n# 访问路径: '+path+'\nvalue = data'+br;
    }
    if(lang==='js'){
      if(lib==='lodash')return"const _ = require('lodash');\nconst obj = JSON.parse(jsonText);\n// 访问路径: "+path+"\nconst value = _.get(obj, '"+jLodash(parts)+"');";
      return'const obj = JSON.parse(jsonText);\n// 访问路径: '+path+'\nconst value = obj'+jJsAccess(parts)+';';
    }
    if(lang==='go'){
      if(lib==='gjson')return'import "github.com/tidwall/gjson"\n\n// 访问路径: '+path+'\nvalue := gjson.Get(jsonText, "'+jDot(parts)+'")';
      if(lib==='sonic'){
        var sp=parts.map(function(p){return jIsIdx(p)?p:'"'+p+'"';}).join(', ');
        return'import "github.com/bytedance/sonic"\n\n// 访问路径: '+path+'\nnode, _ := sonic.Get([]byte(jsonText)'+(sp?', '+sp:'')+')\nvalue, _ := node.Interface()';
      }
      return jGoStd(parts,path);
    }
    if(lang==='rs'){
      if(lib==='simd')return'use simd_json::prelude::*;\n\nlet mut bytes = json_text.as_bytes().to_vec();\nlet v = simd_json::to_borrowed_value(&mut bytes).unwrap();\n// 访问路径: '+path+'\nlet value = &v'+br+';';
      return'use serde_json::Value;\n\nlet v: Value = serde_json::from_str(json_text).unwrap();\n// 访问路径: '+path+'\nlet value = &v'+br+';';
    }
    // 易语言
    var zyPath=jLodash(parts);
    if(lib==='jingyi'){
      var jc='.版本 2\n\n.局部变量 jsn, 类_json\n\njsn.解析 (json文本)\n';
      if(zyPath)jc+='\'; 访问路径: '+zyPath+'\n值 ＝ jsn.取通用属性 ("'+zyPath+'")\n';
      else jc+='\'; jsn 已为根节点, 用 .取通用属性 ("键名") 访问子成员\n';
      return jc;
    }
    var code='.版本 2\n\n.局部变量 zyJson, zyJsonDocument\n\nzyJson.解析 (json文本)\n';
    if(zyPath){code+='\'; 访问路径: '+zyPath+'\n值 ＝ zyJson.取文本 ("'+zyPath+'")\n\'; 也可用 取长整数() 或 取逻辑值()\n';}
    else{code+='\'; zyJson 已为根对象, 可通过 .取文本() 访问子成员\n';}
    return code;
  }

  // ═══════════════════════ CALCULATOR FIXED ═══════════════════════
  function renderCalculator(page) { var d=page.data; var display=calcDisplay(d);
    $('page').innerHTML='<div class="tool-page">'+renderHero(page,
      '<button class="btn small" id="copyCalc">'+tt('复制结果')+'</button>')+
      '<div class="calc-shell"><div class="panel-card"><div class="panel-title">Programmer Calculator</div>'+
      '<div class="calc-display"><div class="calc-expr-row"><input class="mono" id="calcExpression" value="'+esc(d.expr)+'"><button class="btn primary" id="runCalc" style="min-width:48px;height:40px;font-size:18px;font-weight:900;margin:0">=</button></div>'+
      '<div class="calc-main-value">'+esc(display.dec)+'</div>'+
      '<div class="base-grid"><div class="base-row"><div class="base-label">HEX</div><div class="base-value">'+esc(display.hex)+'</div></div><div class="base-row"><div class="base-label">DEC</div><div class="base-value">'+esc(display.dec)+'</div></div><div class="base-row"><div class="base-label">OCT</div><div class="base-value">'+esc(display.oct)+'</div></div><div class="base-row"><div class="base-label">BIN</div><div class="base-value">'+esc(display.bin)+'</div></div></div>'+
      '<div class="bit-grid">'+display.bits+'</div></div></div>'+
      '<div class="panel-card"><div class="panel-title">Controls</div>'+
      '<div class="calc-controls"><label>字长</label><select id="calcWord"><option value="64">QWORD 64-bit</option><option value="32">DWORD 32-bit</option><option value="16">WORD 16-bit</option><option value="8">BYTE 8-bit</option></select>'+
      '<label>显示基数</label><select id="calcBase"><option>DEC</option><option>HEX</option><option>OCT</option><option>BIN</option></select>'+
      '<div class="button-row"><button class="btn small" data-calc-op="and">AND</button><button class="btn small" data-calc-op="or">OR</button><button class="btn small" data-calc-op="xor">XOR</button><button class="btn small" data-calc-op="not">NOT</button><button class="btn small" data-calc-op="lsh">LSH</button><button class="btn small" data-calc-op="rsh">RSH</button></div>'+
      '<div class="calc-keypad">'+'789ABCDEF4560123'.split('').map(function(k){return'<button class="btn" data-calc-key="'+k+'">'+k+'</button>';}).join('')+'<button class="btn" data-calc-key=" + ">+</button><button class="btn" data-calc-key=" - ">-</button><button class="btn" data-calc-key=" * ">*</button><button class="btn" data-calc-key=" / ">/</button><button class="btn danger" id="calcClear">C</button></div>'+
      '</div></div></div></div>';
    $('calcWord').value=String(d.word);$('calcBase').value=d.base;
  }
  function maskFor(word){return word>=64?(1n<<64n)-1n:(1n<<BigInt(word))-1n;}
  function calcDisplay(d){var v=BigInt(Math.trunc(Number(d.value||0)))&maskFor(d.word);var bin=v.toString(2).padStart(d.word,'0');return{dec:v.toString(10),hex:'0x'+v.toString(16).toUpperCase(),oct:'0o'+v.toString(8),bin:'0b'+bin,bits:bin.split('').map(function(b,i){return'<div class="bit'+(b==='1'?' on':'')+'"><div>'+b+'</div><div class="bit-index">'+(d.word-i-1)+'</div></div>';}).join('')};}
  function runCalc(page){
    page.data.expr=$('calcExpression').value;
    if($('calcWord'))page.data.word=Number($('calcWord').value);
    if($('calcBase'))page.data.base=$('calcBase').value;
    try{if(!/^[\d\sxa-fA-FbBoO()+\-*/%&|^~<>().]+$/.test(page.data.expr))throw new Error('表达式含不允许字符');page.data.value=Function('"use strict";return ('+page.data.expr+');')();}catch(e){page.data.value=0;page.data.expr='0';}
    renderCalculator(page);
  }

  // ═══════════════════════ MSAA REDESIGNED ═══════════════════════
  function renderMsaaDetailPart(page){ var d=page.data; var selected=d.selectedNode||d.tree||null;
    var panel=document.querySelector('.msaa-detail');
    if(panel) panel.innerHTML='<div class="panel-title">节点详情</div>'+renderMsaaDetail(selected);
  }
  function renderMsaa(page) { var d=page.data; var selected=d.selectedNode||d.tree||null;
    $('page').innerHTML='<div class="tool-page">'+renderHero(page,
      '<div class="msaa-top-bar"><button class="target-btn scope-pick" id="pickMsaa" title="'+tt('瞄准镜拖拽拾取窗口')+'"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3"/><line x1="12" y1="4" x2="12" y2="1"/><line x1="12" y1="20" x2="12" y2="23"/><line x1="4" y1="12" x2="1" y2="12"/><line x1="20" y1="12" x2="23" y2="12"/></svg></button><input class="mono msaa-hwnd-inline" id="msaaHwnd" placeholder="0x00123456" value="'+esc(d.hwnd)+'"><button class="btn primary" id="inspectMsaa">'+tt('解析')+'</button><button class="btn small" id="copyMsaa">'+tt('复制')+'</button></div>')+
      '<div class="msaa-workbench">'+
      '<section class="panel-card msaa-tree-panel"><div class="panel-title">ACC 组件树</div><pre class="result-box msaa-status" style="min-height:22px;font-size:10px;margin-bottom:6px">'+esc(d.result||'等待选择窗口...')+'</pre><div class="pro-tree" id="msaaTree" style="max-height: calc(100vh - 190px)">'+renderMsaaTree(d.tree,0,d.selectedPath||'')+'</div></section>'+
      '<section class="panel-card msaa-detail"><div class="panel-title">节点详情</div>'+renderMsaaDetail(selected)+'</section>'+
      '</div></div>';
  }

  function renderMsaaTree(node, depth, selectedPath, path, maxOpen) {
    if(!node)return'<div class="empty">输入 HWND 后解析，或使用瞄准镜选择窗口。</div>';
    depth=depth||0;path=path||'0';maxOpen=maxOpen==null?3:maxOpen;
    var label=node.name||node.className||node.class||node.hwnd||'node';
    var meta=[node.role,node.state].filter(Boolean).join(' · ');
    var active=selectedPath===path?' active':'';
    var hasKids=node.children&&node.children.length;
    var open=depth<maxOpen?'open':'';
    var twist=hasKids?(open?'▼':'▶'):'';
    // 角色 SVG 图标
    var role=(node.role||'').toLowerCase();
    var roleSvg='';
    if(role==='window')roleSvg='<svg viewBox="0 0 16 16"><rect x="1" y="2" width="14" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><line x1="1" y1="5" x2="15" y2="5" stroke="currentColor" stroke-width="1"/></svg>';
    else if(role==='button')roleSvg='<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><line x1="5" y1="8" x2="11" y2="8" stroke="currentColor" stroke-width="1.2"/></svg>';
    else if(role==='text'||role==='edit')roleSvg='<svg viewBox="0 0 16 16"><line x1="3" y1="4" x2="13" y2="4" stroke="currentColor" stroke-width="1.2"/><line x1="3" y1="7" x2="11" y2="7" stroke="currentColor" stroke-width="1"/><line x1="3" y1="10" x2="13" y2="10" stroke="currentColor" stroke-width="1.2"/><line x1="7" y1="10" x2="7" y2="13" stroke="currentColor" stroke-width="1"/></svg>';
    else if(role==='list'||role==='menu'||role==='menubar')roleSvg='<svg viewBox="0 0 16 16"><circle cx="5" cy="5" r="1.2" fill="currentColor"/><line x1="8" y1="5" x2="14" y2="5" stroke="currentColor" stroke-width="1.2"/><circle cx="5" cy="8" r="1.2" fill="currentColor"/><line x1="8" y1="8" x2="14" y2="8" stroke="currentColor" stroke-width="1.2"/><circle cx="5" cy="11" r="1.2" fill="currentColor"/><line x1="8" y1="11" x2="14" y2="11" stroke="currentColor" stroke-width="1.2"/></svg>';
    else if(role==='group')roleSvg='<svg viewBox="0 0 16 16"><rect x="1" y="2" width="14" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2,1.5"/></svg>';
    else if(role==='tree'||role==='treeitem')roleSvg='<svg viewBox="0 0 16 16"><circle cx="8" cy="4" r="2" fill="none" stroke="currentColor" stroke-width="1.2"/><line x1="8" y1="6" x2="8" y2="10" stroke="currentColor" stroke-width="1.2"/><line x1="4" y1="9" x2="12" y2="9" stroke="currentColor" stroke-width="1"/></svg>';
    else if(role==='checkbox'||role==='radio')roleSvg='<svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.2"/><polyline points="5,8 7,10 11,6" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
    else if(role==='tab'||role==='tabitem')roleSvg='<svg viewBox="0 0 16 16"><path d="M2 3h4l1 2h7v8H2V3z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
    else if(role==='link')roleSvg='<svg viewBox="0 0 16 16"><path d="M5 11V7a3 3 0 0 1 6 0v4" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="4" r="1.5" fill="currentColor"/></svg>';
    else if(role==='image')roleSvg='<svg viewBox="0 0 16 16"><rect x="1" y="2" width="14" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="5" cy="6" r="1.5" fill="currentColor"/><polygon points="1,14 6,9 9,12 13,7 15,10 15,14" fill="currentColor" opacity="0.3"/></svg>';
    else if(role==='progress')roleSvg='<svg viewBox="0 0 16 16"><rect x="1" y="5" width="14" height="6" rx="3" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="2" y="6" width="8" height="4" rx="2" fill="currentColor" opacity="0.6"/></svg>';
    else if(role==='slider'||role==='scrollbar')roleSvg='<svg viewBox="0 0 16 16"><line x1="4" y1="4" x2="4" y2="12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="12" y1="4" x2="12" y2="12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="4" y1="8" x2="12" y2="8" stroke="currentColor" stroke-width="2"/></svg>';
    else if(role==='dialog')roleSvg='<svg viewBox="0 0 16 16"><rect x="1" y="2" width="14" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><polygon points="4,12 7,12 3,8" fill="currentColor" opacity="0.5"/></svg>';
    else roleSvg='<svg viewBox="0 0 16 16"><rect x="1" y="2" width="14" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
    var roleCls=role||'default';
    var html='<div class="msaa-node'+active+(hasKids?' has-kids':'')+' '+open+'" data-msaa-path="'+esc(path)+'" style="--depth:'+depth+'" title="'+esc(label)+' | '+esc(meta)+'"><span class="msaa-twist">'+twist+'</span><span class="msaa-icon" data-role="'+roleCls+'">'+roleSvg+'</span><span class="msaa-label">'+esc(label)+'</span><span class="msaa-meta">'+esc(meta)+'</span></div>';
    if(hasKids){
      var display=open?'':' style="display:none"';
      html+='<div class="msaa-children"'+display+'>';
      node.children.forEach(function(child,index){html+=renderMsaaTree(child,depth+1,selectedPath,path+'.'+index,maxOpen);});
      html+='</div>';
    }
    return html;
  }

  function renderMsaaDetail(node) {
    if(!node)return'<div class="empty">选择树节点查看详情。</div>';
    var childCount=(node.children||[]).length;
    var rectStr=node.rect?'['+[node.rect.left,node.rect.top,node.rect.right,node.rect.bottom].join(',')+']':'';
    var rows=[
      ['Name',node.name||'(empty)'],
      ['Role',node.role||''],
      ['State',node.state||''],
      ['Value',node.value||''],
      ['Description',node.description||''],
      ['Help',node.help||''],
      ['Shortcut',node.shortcut||''],
      ['DefaultAction',node.defaultAction||''],
      ['HWND (if window)',node.hwnd||''],
      ['ClassName',node.className||''],
      ['ChildCount',String(childCount)],
      ['Rect',rectStr]
    ];
    return'<div class="detail-grid" style="max-height:calc(100vh - 430px);overflow:auto">'+rows.filter(function(r){return r[1];}).map(function(r){return'<div class="detail-row"><span>'+esc(r[0])+'</span><strong>'+esc(r[1])+'</strong></div>';}).join('')+'</div>';
  }

  function getTreeNodeByPath(root, path) {
    if(!root||!path)return root||null;
    var parts=String(path).split('.').slice(1);var node=root;
    for(var i=0;i<parts.length;i++){var index=Number(parts[i]);node=node&&node.children?node.children[index]:null;if(!node)break;}
    return node||root;
  }

  function renderMsaaText(node, depth) {
    if(!node)return'无 MSAA 数据';
    depth=depth||0;
    var line=new Array(depth+1).join('  ')+'- '+(node.name||node.className||node.class||node.hwnd||'node')+' ['+(node.role||'')+'] '+(node.state||'');
    return[line].concat((node.children||[]).map(function(child){return renderMsaaText(child,depth+1);})).join('\n');
  }

  // ═══════════════════════ PROCESS ENHANCED ═══════════════════════
  var procIconCache = {}; // pid/name/path -> base64, 持久化进程图标
  function isSysPath(path){ return path&&(path.indexOf('\\Windows\\System32\\')!==-1||path.indexOf('\\Windows\\SysWOW64\\')!==-1||path.indexOf('\\Windows\\WinSxS\\')!==-1); }
  function isSystemProc(p){
    var name=String((p&&p.name)||'').toLowerCase();
    return name==='svchost.exe' || (p&&p.perm==='Sys') || (p&&p.perm==='---') || isSysPath(p&&p.path);
  }
  function renderProcess(page) { var d=page.data; var items=Array.isArray(d.result)?d.result:[];
    var hasData=items.length>0;
    var hideSys=!!d._hideSystem; var showHex=!!d._showHex;
    var searchTerm=(d._procSearch||'').toLowerCase();
    var filtered=hasData?items.filter(function(p){
      if(hideSys&&isSystemProc(p))return false;
      if(searchTerm&&p.name&&p.name.toLowerCase().indexOf(searchTerm)<0)return false;
      return true;
    }):items;
    var sysCount=hasData?items.filter(function(p){return isSystemProc(p);}).length:0;
    var stats='<div class="process-stats" id="procStats">'+(hasData?procStatsHtml(page,items,filtered,sysCount,hideSys):procStatsEmptyHtml())+'</div>';
    var emptyText=d._loading?tt('读取中...'):(typeof d.result==='string'&&d.result?d.result:'点击刷新枚举系统进程。');
    var tableRows=hasData?processTableRows(filtered,showHex):'<tr><td colspan="5" class="empty">'+esc(emptyText)+'</td></tr>';
    page.data._procRenderSig=processVisibleSignature(filtered,showHex);
    $('page').innerHTML='<div class="tool-page">'+renderHero(page,
      '<form onsubmit="return false" style="display:inline"><input id="procSearch" class="mono" value="'+esc(d._procSearch||'')+'" placeholder="🔍 '+tt('搜索进程名...')+'" style="width:180px;height:32px;font-size:12px;display:inline-block;vertical-align:middle;margin-right:4px"></form>'+
      '<label class="proc-filter-label"><input type="checkbox" id="hideSysProc" '+(hideSys?'checked':'')+'> '+tt('隐藏系统进程')+(hideSys&&sysCount?' <span class="proc-filter-badge">'+sysCount+'</span>':'')+'</label>'+
      '<button class="btn primary" id="refreshProcess">'+tt('刷新进程')+'</button>')+
      '<div class="panel-card process-list-card">'+
      stats+
      '<div class="proc-table-wrap"><table class="process-table"><thead><tr><th>进程名</th><th>PID</th><th>权限</th><th>线程</th><th>内存</th></tr></thead><tbody id="procTableBody">'+tableRows+'</tbody></table></div>'+
      '</div></div>';
    if(!hasData&&!d._loadStarted) setTimeout(function(){ refreshProcessTbody(page); setTimeout(function(){ lazyLoadProcIcons(); }, 200); }, 10);
    // 5秒自动刷新（仅当页面活跃）
    if(page.data._autoTimer) clearInterval(page.data._autoTimer);
    page.data._autoTimer=setInterval(function(){
      if(state.activeId!==page.id) return; // 页面不在前台时跳过
      refreshProcessTbody(page); setTimeout(function(){ lazyLoadProcIcons(); }, 300);
    }, 5000);
  }
  function procStatsEmptyHtml(){
    return'<div class="process-stat"><div class="stat-num">--</div><div class="stat-label">Processes</div></div><div class="process-stat"><div class="stat-num">--</div><div class="stat-label">Memory</div></div><div class="process-stat"><div class="stat-num">--</div><div class="stat-label">CPU</div></div>';
  }
  function procStatsHtml(page, items, filtered, sysCount, hideSys){
    var t=hideSys?filtered.length:items.length;
    // 内存：使用系统级 GlobalMemoryStatusEx 数据(字节)
    var memStr='--';
    if(page.data._sysMem){
      var used=(page.data._sysMem.total-page.data._sysMem.avail)/(1024*1024*1024);
      var total=page.data._sysMem.total/(1024*1024*1024);
      memStr=used.toFixed(1)+' / '+total.toFixed(0)+' GB';
    }
    // CPU：使用系统级 GetSystemTimes 差值
    var cpuPct='--';
    if(page.data._sysCpu&&typeof page.data._sysCpu.pct==='number'){
      cpuPct=page.data._sysCpu.pct.toFixed(1);
    }else{
      var prevCpu=page.data._prevSysCpu;
      if(prevCpu&&page.data._sysCpu){
        var dIdle=page.data._sysCpu.idle-prevCpu.idle;
        var dTotal=(page.data._sysCpu.kernel-prevCpu.kernel)+(page.data._sysCpu.user-prevCpu.user);
        if(dTotal>0){
          var used=(1-dIdle/dTotal)*100;
          if(used<0)used=0; if(used>100)used=100;
          cpuPct=used.toFixed(1);
        }
      }
    }
    // 保存快照
    page.data._prevSysCpu=page.data._sysCpu?{idle:page.data._sysCpu.idle,kernel:page.data._sysCpu.kernel,user:page.data._sysCpu.user}:null;
    var extra=hideSys&&sysCount?'<div class="proc-filter-note">已隐藏 '+sysCount+' 个系统进程</div>':'';
    return'<div class="process-stat"><div class="stat-num">'+t+'</div><div class="stat-label">Processes</div></div><div class="process-stat"><div class="stat-num">'+memStr+'</div><div class="stat-label">Memory</div></div><div class="process-stat"><div class="stat-num">'+(cpuPct==='--'?'--':cpuPct+'%')+'</div><div class="stat-label">CPU</div></div>'+extra;
  }
  function processTableRows(items, showHex) {
    return items.slice(0,600).map(function(p){
      var memStr=p.memKB?((p.memKB/1024).toFixed(1)+' MB'):'-';
      var permStr=p.perm||'---';
      var permCls='';
      if(permStr==='Admin')permCls=' style="color:#f59e0b;font-weight:700"';
      else if(permStr==='Sys')permCls=' style="color:var(--danger);font-weight:700"';
      else if(permStr==='---')permCls=' style="color:var(--weak)"';
      var pidText=showHex?'0x'+Number(p.pid||0).toString(16).toUpperCase():String(p.pid||'');
      var iconKey=procIconKey(p);
      var cachedIcon=procIconCache[iconKey]||procIconCache[p.path||'']||'';
      var iconCell=cachedIcon?'<span class="process-icon"><img src="'+esc(cachedIcon)+'" width="16" height="16" style="vertical-align:middle" onerror="this.parentElement.textContent=\''+(p.name||'?').charAt(0).toUpperCase()+'\'"></span>':'<span class="process-icon">'+(p.name||'?').charAt(0).toUpperCase()+'</span>';
      return'<tr data-proc-pid="'+esc(String(p.pid||''))+'" data-proc-name="'+esc(p.name||'')+'" class="proc-row" data-proc-path="'+esc(p.path||'')+'" data-icon-key="'+esc(iconKey)+'"><td title="'+esc(p.path||p.name||'')+'">'+iconCell+esc(p.name||'')+'</td><td class="mono">'+esc(pidText)+'</td><td'+permCls+'>'+esc(permStr)+'</td><td>'+esc(String(p.threads||''))+'</td><td>'+memStr+'</td></tr>';
    }).join('');
  }
  function procVisibleItems(page){
    var items=Array.isArray(page.data.result)?page.data.result:[];
    var hideSys=!!page.data._hideSystem;
    var searchTerm=(page.data._procSearch||'').toLowerCase();
    return items.filter(function(p){
      if(hideSys&&isSystemProc(p))return false;
      if(searchTerm&&p.name&&p.name.toLowerCase().indexOf(searchTerm)<0)return false;
      return true;
    });
  }
  function processVisibleSignature(items, showHex){
    return (items||[]).slice(0,600).map(function(p){
      return [p.pid||'',p.name||'',p.path||'',p.perm||'',p.threads||'',p.memKB||'',showHex?'h':'d'].join('|');
    }).join('\n');
  }
  function procIconKey(p){
    if(!p)return '';
    if(p.path)return 'path:'+p.path;
    return 'pid:'+String(p.pid||'')+':'+String(p.name||'');
  }
  function updateProcessTable(page, force){
    var tbody=$('procTableBody');
    if(!tbody)return;
    var items=procVisibleItems(page);
    var sig=processVisibleSignature(items,!!page.data._showHex);
    if(force||sig!==page.data._procRenderSig){
      tbody.innerHTML=items.length?processTableRows(items,!!page.data._showHex):'<tr><td colspan="5" class="empty">无匹配进程</td></tr>';
      page.data._procRenderSig=sig;
      setTimeout(function(){ lazyLoadProcIcons(); }, 60);
    }
  }
  function updateProcessStats(page){
    var stats=$('procStats');
    if(!stats)return;
    var items=Array.isArray(page.data.result)?page.data.result:[];
    var filtered=procVisibleItems(page);
    var hideSys=!!page.data._hideSystem;
    var sysCount=items.filter(function(p){return isSystemProc(p);}).length;
    stats.innerHTML=items.length?procStatsHtml(page,items,filtered,sysCount,hideSys):procStatsEmptyHtml();
  }
  function refreshProcessTbody(page) {
    var now=Date.now();
    if(page.data._loading) return;
    if(page.data._lastRefresh&&(now-page.data._lastRefresh)<2000) return; // 防止重复点击/自动刷新并发
    page.data._lastRefresh=now;
    page.data._loading=true;
    page.data._loadStarted=true;
    var btn=$('refreshProcess'); if(btn){btn.disabled=true;btn.innerHTML=String.fromCodePoint(0x23F3)+' '+tt('读取中...');}
    var tbody=$('procTableBody');
    var hasRows=tbody&&tbody.querySelector('.proc-row');
    if(tbody&&!hasRows) tbody.innerHTML='<tr><td colspan="5" class="empty">'+tt('读取中...')+'</td></tr>';
    invoke('list_processes',{}).then(function(res){
      var data=parseMaybeJson(res);
      if(!data||data.ok===false) throw new Error((data&&data.error)||'list_processes failed');
      var items=data.items||data.processes||[];
      page.data.result=items;
      page.data._sysMem=data.sysMem||null;
      page.data._sysCpu=data.sysCpu||null;
      page.data._cpuCount=data.cpuCount||navigator.hardwareConcurrency||4;
      page.data._loading=false;
      page.data.rawData=JSON.stringify(data,null,2);
      updateProcessStats(page);
      updateProcessTable(page,!hasRows);
      if(btn){btn.disabled=false;btn.innerHTML=tt('刷新进程');}
    }).catch(function(e){
      page.data.result='读取失败：'+e.message;
      page.data._loading=false;
      var tbody=$('procTableBody');
      var stats=$('procStats');
      if(tbody) tbody.innerHTML='<tr><td colspan="5" class="empty">'+esc(page.data.result)+'</td></tr>';
      if(stats&&!hasRows) stats.innerHTML=procStatsEmptyHtml();
      if(btn){btn.disabled=false;btn.innerHTML=tt('刷新进程');}
    });
    // 异步懒加载图标
    setTimeout(function(){ lazyLoadProcIcons(); }, 50);
  }
  function lazyLoadProcIcons() {
    var tbody=$('procTableBody');if(!tbody)return;
    var rows=tbody.querySelectorAll('.proc-row');
    var pending=[];rows.forEach(function(r){
      var path=r.dataset.procPath||'';
      var iconKey=r.dataset.iconKey||('pid:'+String(r.dataset.procPid||'')+':'+String(r.dataset.procName||''));
      var iconSpan=r.querySelector('.process-icon');
      if(iconSpan&&iconSpan.querySelector('img'))return; // already has icon
      var cached=procIconCache[iconKey]||procIconCache[path||''];
      if(cached){
        // 使用缓存立即填充
        if(iconSpan){
          iconSpan.innerHTML='';
          var img=document.createElement('img');
          img.width=16;img.height=16;
          img.style.cssText='vertical-align:middle';
          img.src=cached;
          iconSpan.appendChild(img);
        }
        return;
      }
      pending.push(r);
    });
    var idx=0;var maxConcurrent=6;
    function next(){
      if(idx>=pending.length)return;
      var row=pending[idx++];
      var path=row.dataset.procPath||'';
      var iconKey=row.dataset.iconKey||('pid:'+String(row.dataset.procPid||'')+':'+String(row.dataset.procName||''));
      invoke('extract_icon',{pid:row.dataset.procPid,path:path}).then(function(res){
        var d=parseMaybeJson(res);
        if(d&&d.ok&&d.icon_base64){
          procIconCache[iconKey]=d.icon_base64; // 缓存
          if(path)procIconCache[path]=d.icon_base64;
          var is=row.querySelector('.process-icon');
          if(is){
            var img=new Image();img.width=16;img.height=16;
            img.style.cssText='vertical-align:middle';
            img.onload=function(){is.innerHTML='';is.appendChild(img);};
            img.onerror=function(){is.textContent='?';};
            img.src=d.icon_base64;
          }
        }
      }).catch(function(){});
      setTimeout(next,25);
    }
    for(var b=0;b<maxConcurrent&&idx<pending.length;b++)next();
  }

  // ═══════════════════════ COLOR PICKER v2 ═══════════════════════
  var _colorHarmCache = {};
  function colorSwatchHtml(hex,label,small){var sz=small?'24':'32';return'<div class="cp-swatch" data-cp="'+hex+'" title="'+esc(label||hex)+' — '+tt('点击复制')+'"><div class="cp-swatch-color" style="background:'+hex+';width:'+sz+'px;height:'+sz+'px"></div>'+(label?'<span>'+esc(label)+'</span>':'')+'</div>';}
  function colorHarmonies(hex){
    var r=hexToRgb(hex),hsl=rgbToHslObj(r.r,r.g,r.b);
    function h2hex(dh){var nh=(hsl.h+dh+360)%360;return hslToHex(nh,hsl.s,hsl.l);}
    return{h180:h2hex(180),h30a:h2hex(30),h30b:h2hex(-30),h120a:h2hex(120),h120b:h2hex(-120),h150a:h2hex(150),h150b:h2hex(-150)};
  }
  function tintShadeHtml(hex,n){
    var r=hexToRgb(hex),out='';
    for(var i=-n;i<=n;i++){
      var t=i>0?Math.round(255-(255-r.r)*i/n):Math.round(r.r*(n+i)/n);
      var g=i>0?Math.round(255-(255-r.g)*i/n):Math.round(r.g*(n+i)/n);
      var b=i>0?Math.round(255-(255-r.b)*i/n):Math.round(r.b*(n+i)/n);
      var c=rgbToHex(Math.max(0,Math.min(255,t)),Math.max(0,Math.min(255,g)),Math.max(0,Math.min(255,b)));
      out+='<div class="cp-tint-dot" style="background:'+c+'" data-cp="'+c+'" title="'+c.toUpperCase()+' — '+tt('点击复制')+'"></div>';
    }
    return out;
  }
  function renderColor(page) { var d=page.data; var hex=d.color||'#3b82f6'; var rgb=hexToRgb(hex); var hsl=rgbToHslObj(rgb.r,rgb.g,rgb.b);
    var harm=colorHarmonies(hex);
    $('page').innerHTML='<div class="tool-page">'+renderHero(page,
      '<button class="btn primary" id="pickScreenColor" style="min-height:40px;font-size:14px;font-weight:700;padding:0 22px">🎯 '+tt('屏幕取色')+'</button><button class="btn small" id="saveColor">📌 '+tt('记录')+'</button><button class="btn small" id="clearColorHistory">🗑 '+tt('清空')+'</button>')+
      '<div class="cp-grid">'+
      '<div class="cp-col"><div class="cp-preview" id="colorBig" style="background:'+hex+'"><span class="cp-preview-hex" id="colorHexBig">'+hex.toUpperCase()+'</span></div>'+
      '<div class="cp-hex-row"><input class="mono cp-hex-in" id="colorHexIn" value="'+hex+'" placeholder="#HEX"><label class="cp-native-wrap"><input type="color" id="colorNative2" value="'+hex+'"><span>🎨</span></label></div>'+
      '<div class="cp-section"><div class="cp-section-title">'+tt('色阶')+'</div><div class="cp-tints" id="cpTints">'+tintShadeHtml(hex,5)+'</div></div>'+
      '<div class="cp-section"><div class="cp-section-title">'+tt('记录')+' ('+(d.history||[]).length+')</div><div class="cp-history" id="colorHis">'+(d.history||[]).slice(0,30).map(function(c){return'<div class="cp-hist-row" data-color="'+c+'"><div class="cp-hist-swatch" style="background:'+c+'"></div><span class="cp-hist-hex">'+c.toUpperCase()+'</span></div>';}).join('')+'</div></div>'+
      '</div>'+
      '<div class="cp-col"><div class="cp-section"><div class="cp-section-title">RGB</div>'+
      colorSliderCp('R',rgb.r,0,255,'rgb',hex,function(v,lbl){var r2=hexToRgb(hex);return rgbToHex(lbl==='R'?v:r2.r,lbl==='G'?v:r2.g,lbl==='B'?v:r2.b);})+
      colorSliderCp('G',rgb.g,0,255,'rgb',hex,function(v,lbl){var r2=hexToRgb(hex);return rgbToHex(lbl==='R'?v:r2.r,lbl==='G'?v:r2.g,lbl==='B'?v:r2.b);})+
      colorSliderCp('B',rgb.b,0,255,'rgb',hex,function(v,lbl){var r2=hexToRgb(hex);return rgbToHex(lbl==='R'?v:r2.r,lbl==='G'?v:r2.g,lbl==='B'?v:r2.b);})+
      '</div><div class="cp-section"><div class="cp-section-title">HSL</div>'+
      colorSliderCp('H',Math.round(hsl.h),0,360,'hsl',hex,function(v,lbl){var hs=rgbToHslObj(hexToRgb(hex).r,hexToRgb(hex).g,hexToRgb(hex).b);return hslToHex(lbl==='H'?v:hs.h,lbl==='S'?v:hs.s,lbl==='L'?v:hs.l);})+
      colorSliderCp('S',Math.round(hsl.s),0,100,'hsl',hex,function(v,lbl){var hs=rgbToHslObj(hexToRgb(hex).r,hexToRgb(hex).g,hexToRgb(hex).b);return hslToHex(lbl==='H'?v:hs.h,lbl==='S'?v:hs.s,lbl==='L'?v:hs.l);})+
      colorSliderCp('L',Math.round(hsl.l),0,100,'hsl',hex,function(v,lbl){var hs=rgbToHslObj(hexToRgb(hex).r,hexToRgb(hex).g,hexToRgb(hex).b);return hslToHex(lbl==='H'?v:hs.h,lbl==='S'?v:hs.s,lbl==='L'?v:hs.l);})+
      '</div>'+
      '<div class="cp-section"><div class="cp-section-title">'+tt('配色和谐')+'</div>'+
      '<div class="cp-harmony-grid">'+
      '<div class="cp-harm-group"><span class="cp-harm-label">'+tt('互补')+'</span>'+colorSwatchHtml(harm.h180)+'</div>'+
      '<div class="cp-harm-group"><span class="cp-harm-label">'+tt('相似')+'</span><div class="cp-harm-pair">'+colorSwatchHtml(harm.h30b,'',true)+colorSwatchHtml(harm.h30a,'',true)+'</div></div>'+
      '<div class="cp-harm-group"><span class="cp-harm-label">'+tt('三角')+'</span><div class="cp-harm-pair">'+colorSwatchHtml(harm.h120a,'',true)+colorSwatchHtml(harm.h120b,'',true)+'</div></div>'+
      '<div class="cp-harm-group"><span class="cp-harm-label">'+tt('分裂')+'</span><div class="cp-harm-pair">'+colorSwatchHtml(harm.h150a,'',true)+colorSwatchHtml(harm.h150b,'',true)+'</div></div>'+
      '</div></div></div>'+
      '<div class="cp-col"><div class="cp-section"><div class="cp-section-title">'+tt('格式')+'</div>'+
      cfCardCp('HEX',hex.toUpperCase())+
      cfCardCp('RGB','rgb('+rgb.r+', '+rgb.g+', '+rgb.b+')')+
      cfCardCp('RGBA','rgba('+rgb.r+', '+rgb.g+', '+rgb.b+', 1)')+
      cfCardCp('HSL','hsl('+Math.round(hsl.h)+', '+Math.round(hsl.s)+'%, '+Math.round(hsl.l)+'%)')+
      cfCardCp('HSLA','hsla('+Math.round(hsl.h)+', '+Math.round(hsl.s)+'%, '+Math.round(hsl.l)+'%, 1)')+
      cfCardCp('HSV',rgbToHsv(rgb.r,rgb.g,rgb.b))+
      cfCardCp('CMYK',rgbToCmyk(rgb.r,rgb.g,rgb.b))+
      '</div></div></div></div>';
  }
  function colorSliderCp(label,val,min,max,type,currentHex,rebuildFn){
    return'<div class="color-slider-row cp-slider"><span>'+label+'</span><input type="range" class="cslider" id="cs'+label+'" min="'+min+'" max="'+max+'" value="'+val+'" data-chan="'+label.toLowerCase()+'" data-type="'+type+'"><input type="number" class="cnum" id="cn'+label+'" value="'+val+'" min="'+min+'" max="'+max+'" data-chan="'+label.toLowerCase()+'"></div>';
  }
  function cfCardCp(label,value){return'<div class="cf-card cp-card"><span>'+label+'</span><code>'+esc(value)+'</code><button data-cp="'+esc(value)+'" title="'+tt('复制')+'"></button></div>';}
  function colorSlider(label,val,min,max,type){
    var bg='';var pct=Math.round((val-min)/(max-min)*100);
    if(type==='rgb')bg='linear-gradient(to right, #000, rgb('+(label==='R'?val+',0,0':label==='G'?'0,'+val+',0':'0,0,'+val)+'))';
    else{var h=label==='H'?val:0;var s=label==='S'?val:100;var l=label==='L'?val:50;bg='linear-gradient(to right, hsl(0,0%,'+l+'%), hsl('+h+','+s+'%,'+l+'%))';}
    return'<div class="color-slider-row"><span>'+label+'</span><input type="range" class="cslider" style="--sbg:'+bg+'" id="cs'+label+'" min="'+min+'" max="'+max+'" value="'+val+'" data-chan="'+label.toLowerCase()+'" data-type="'+type+'"><input type="number" class="cnum" id="cn'+label+'" value="'+val+'" min="'+min+'" max="'+max+'" data-chan="'+label.toLowerCase()+'"></div>';
  }
  function cfCard(label,value){return'<div class="cf-card"><span>'+label+'</span><code>'+esc(value)+'</code><button data-cp="'+esc(value)+'" title="'+tt('复制')+'"></button></div>';}
  // 不重绘全页，只更新颜色相关的 DOM
  function updateColorUI(color){var rgb=hexToRgb(color);var hsl=rgbToHslObj(rgb.r,rgb.g,rgb.b);
    var big=$('colorBig');if(big)big.style.background=color;
    var ht=$('colorHexBig');if(ht)ht.textContent=color.toUpperCase();
    var hi=$('colorHexIn');if(hi&&document.activeElement!==hi)hi.value=color;
    var nc2=$('colorNative2');if(nc2)nc2.value=color;
    setCS('csR','cnR',rgb.r);setCS('csG','cnG',rgb.g);setCS('csB','cnB',rgb.b);
    setCS('csH','cnH',Math.round(hsl.h));setCS('csS','cnS',Math.round(hsl.s));setCS('csL','cnL',Math.round(hsl.l));
  }
  function setCS(sid,nid,val){var s=$(sid);var n=$(nid);if(s&&document.activeElement!==s)s.value=val;if(n&&document.activeElement!==n)n.value=val;}
  function updateSliderBg(sid,val,type,chan){
    var s=$(sid);if(!s)return;
    if(type==='rgb')s.style.setProperty('--sbg','linear-gradient(to right, #000, rgb('+(chan==='r'?val+',0,0':chan==='g'?'0,'+val+',0':'0,0,'+val)+'))');
    else{var h=chan==='h'?val:0,sl=chan==='s'?val:100,li=chan==='l'?val:50;s.style.setProperty('--sbg','linear-gradient(to right, hsl(0,0%,'+li+'%), hsl('+h+','+sl+'%,'+li+'%))');}
  }
  function updCard(card,label,val){card.innerHTML='<span>'+label+'</span><code>'+esc(val)+'</code><button data-cp="'+esc(val)+'">'+tt('复制')+'</button>';}
  function hexToRgb(hex){var n=parseInt(String(hex).replace('#',''),16)||0;return{r:(n>>16)&255,g:(n>>8)&255,b:n&255};}
  function rgbToHex(r,g,b){return'#'+((1<<24)|(r<<16)|(g<<8)|b).toString(16).slice(1);}
  function rgbToHsl(rr,gg,bb){var r=rr/255,g=gg/255,b=bb/255;var max=Math.max(r,g,b),min=Math.min(r,g,b);var h=0,s=0,l=(max+min)/2;if(max!==min){var d=max-min;s=l>0.5?d/(2-max-min):d/(max+min);if(max===r)h=((g-b)/d+(g<b?6:0))/6;else if(max===g)h=((b-r)/d+2)/6;else h=((r-g)/d+4)/6;}return'hsl('+Math.round(h*360)+', '+Math.round(s*100)+'%, '+Math.round(l*100)+'%)';}
  function rgbToHslObj(rr,gg,bb){var r=rr/255,g=gg/255,b=bb/255;var max=Math.max(r,g,b),min=Math.min(r,g,b);var h=0,s=0,l=(max+min)/2;if(max!==min){var d=max-min;s=l>0.5?d/(2-max-min):d/(max+min);if(max===r)h=((g-b)/d+(g<b?6:0))/6;else if(max===g)h=((b-r)/d+2)/6;else h=((r-g)/d+4)/6;}return{h:h*360,s:s*100,l:l*100};}
  function hslToHex(hh,ss,ll){var h=hh/360,s=ss/100,l=ll/100;if(s===0){var v=Math.round(l*255);return rgbToHex(v,v,v);}var q=l<0.5?l*(1+s):l+s-l*s;var p=2*l-q;function hue2rgb(t){if(t<0)t+=1;if(t>1)t-=1;if(t<1/6)return p+(q-p)*6*t;if(t<1/2)return q;if(t<2/3)return p+(q-p)*(2/3-t)*6;return p;}return rgbToHex(Math.round(hue2rgb(h+1/3)*255),Math.round(hue2rgb(h)*255),Math.round(hue2rgb(h-1/3)*255));}
  function rgbToCmyk(r,g,b){var rr=r/255,gg=g/255,bb=b/255;var k=1-Math.max(rr,gg,bb);if(k>=1)return'cmyk(0%, 0%, 0%, 100%)';var c=(1-rr-k)/(1-k);var m=(1-gg-k)/(1-k);var y=(1-bb-k)/(1-k);return'cmyk('+Math.round(c*100)+'%, '+Math.round(m*100)+'%, '+Math.round(y*100)+'%, '+Math.round(k*100)+'%)';}
  function rgbToHsv(r,g,b){var rr=r/255,gg=g/255,bb=b/255;var max=Math.max(rr,gg,bb),min=Math.min(rr,gg,bb),d=max-min;var h=0,s=max===0?0:d/max;if(d!==0){if(max===rr)h=((gg-bb)/d%6+6)%6;else if(max===gg)h=(bb-rr)/d+2;else h=(rr-gg)/d+4;h*=60;}return'hsv('+Math.round(h)+', '+Math.round(s*100)+'%, '+Math.round(max*100)+'%)';}

  // ═══════════════════════ WINDOW SPY FIXED ═══════════════════════
  function renderWinSpy(page) { var d=page.data;
    // ★ 首次渲染立即触发加载（不等 setTimeout）★
    if(!d._treeLoading && !d._treeLoaded){
      d._treeLoading=true;
      invoke('spy_tree',{}).then(function(res){
        var data=parseMaybeJson(res);
        d.tree=data.items||[]; d._treeLoaded=true; d._treeLoading=false;
        d.result=(d.tree.length||0)+' 个窗口已枚举';
        if(!d.tree.length) d.result+=' (空 — 请右键刷新)';
        renderWinSpy(page);
      }).catch(function(e){d._treeLoading=false; d.result='枚举失败：'+e.message; renderWinSpy(page);});
    }
    // 渲染
    var treeLoading=d._treeLoading&&!d._treeLoaded;
    $('page').innerHTML='<div class="tool-page">'+renderHero(page,
      '<div class="msaa-top-bar"><button class="target-btn scope-pick" id="pickSpyWindow" title="'+tt('瞄准镜选择窗口')+'"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3"/><line x1="12" y1="4" x2="12" y2="1"/><line x1="12" y1="20" x2="12" y2="23"/><line x1="4" y1="12" x2="1" y2="12"/><line x1="20" y1="12" x2="23" y2="12"/></svg></button><input class="mono msaa-hwnd-inline" id="spyHwnd" value="'+esc(d.hwnd)+'" placeholder="1e0b5a"><button class="btn primary" id="spyWindow">'+tt('解析')+'</button><button class="btn small" id="refreshWindows">'+tt('刷新')+'</button></div>')+
      '<div class="spy-layout"><div class="panel-card spy-left"><div class="panel-title">'+tt('窗口属性')+'</div>'+
      '<div class="spy-detail-grid" id="spyDetailArea">'+renderSpyDetail(d.detail)+'</div>'+ 
      '<div class="spy-status">'+esc(d.result||'')+'</div></div>'+ 
      '<div class="panel-card spy-right"><div class="panel-title">桌面窗口树 ('+(d._treeLoaded?(d.tree||[]).length:'...')+')</div>'+
      '<div class="spy-tree" id="spyComponentTree" style="overflow:auto;max-height:610px">'+(treeLoading?'<div class="empty-tree">⏳ 正在枚举窗口...</div>':renderSpyTree(d.tree||[]))+'</div></div></div></div>';
  }

  function hwndDec(hex){var n=parseInt(hex,16);return isNaN(n)?'':String(n);}
  function renderSpyTree(items) {
    if(!items||!items.length)return'<div class="empty-tree">右键桌面窗口树区域可刷新</div>';
    function node(w,depth){
      var children=w.children||[], hasChild=children.length>0;
      var isSys=cls&&/^(Shell_TrayWnd|Button|Static|ScrollBar|ToolbarWindow32|msctls_statusbar32|SysListView32|SysTreeView32|SysTabControl32|ComboBox|Edit|ListBox|msctls_trackbar32|msctls_updown32|SysHeader32|SysLink|#\d+)$/i.test(cls);
      var autoExpand=depth===0||((!isSys)&&(w.childVis||0)>0); // 系统窗口默认折叠
      var hwndHex=w.hwnd||'', hwndDecStr=hwndDec(hwndHex);
      var title=w.title?esc(w.title):'';
      var cls=w.className||'Window';
      var iconHtml=w.icon?'<img class="spy-icon" src="'+w.icon+'" width="16" height="16">':'<span class="spy-icon-plc" style="opacity:0.3">▣</span>';
      var twist='<span class="spy-twist" data-spy-twist="'+esc(hwndHex)+'" style="cursor:pointer;width:14px;display:inline-block;text-align:center">'+(hasChild?(autoExpand?'▼':'▶'):'·')+'</span>';
      var visibleDot=w.visible!==false?'<span class="spy-vis-dot" title="可见">●</span>':'<span class="spy-vis-dot off" title="隐藏">○</span>';
      var dim=w.w&&w.h?'<span class="spy-dim">'+w.w+'×'+w.h+'</span>':'';
      return'<div class="spy-node" data-spy-hwnd="'+esc(hwndHex)+'" style="padding-left:'+(depth*16)+'px">'+
        twist+iconHtml+visibleDot+'<span class="spy-node-cls">'+esc(cls)+'</span>'+
        '<span class="spy-node-hwnd mono" title="'+esc(hwndHex)+' (十进制:'+esc(hwndDecStr)+')">'+esc(hwndHex)+' <b style="opacity:0.5;font-weight:400">'+esc(hwndDecStr)+'</b></span>'+
        (title?'<span class="spy-node-title">'+title+'</span>':'')+
        dim+'</div>'+
        (hasChild?'<div class="spy-children" data-spy-parent="'+esc(hwndHex)+'" style="display:'+(autoExpand?'':'none')+'">'+children.map(function(c){return node(c,depth+1);}).join('')+'</div>':'');
    }
    return items.map(function(w){return node(w,0);}).join('');
  }

  function renderSpyDetail(d) {
    if(!d||d.error)return'<div class="empty">选择或输入窗口句柄后解析。左侧点击窗口树节点或手动输入 HWND。</div>';
    var hwndHex=d.hwnd||d.handle||'';
    var hwndDec=hwndHex?String(parseInt(hwndHex,16)):'';
    var rel=d.relations||{};
    function relation(key){
      var value=d[key]||rel[key]||'';
      return /^0x0+$/i.test(String(value))?'':String(value);
    }
    function row(label,value){
      if(value===undefined||value===null||value==='')return'';
      return'<div class="spy-detail-row"><span>'+esc(label)+'</span><strong>'+esc(String(value))+'</strong></div>';
    }
    function rectRow(label,r){
      if(!r)return'';
      var left=Number(r.left)||0, top=Number(r.top)||0, right=Number(r.right)||0, bottom=Number(r.bottom)||0;
      var width=r.width!=null?Number(r.width):right-left, height=r.height!=null?Number(r.height):bottom-top;
      var copy=[left,top,right,bottom].join(',');
      return'<div class="spy-detail-row spy-rect-detail" data-cp="'+esc(copy)+'"><span>'+esc(label)+'</span><div class="spy-rect-values">'+
        '<div class="spy-rect-line"><b>L</b><strong>'+left+'</strong><b>T</b><strong>'+top+'</strong><b>R</b><strong>'+right+'</strong><b>B</b><strong>'+bottom+'</strong></div>'+ 
        '<div class="spy-rect-size"><span>尺寸</span><strong>'+width+' × '+height+'</strong></div></div></div>';
    }
    function styleName(flag){
      var names={VISIBLE:'可见',DISABLED:'已禁用',CHILD:'子窗口',POPUP:'弹出窗口',CAPTION:'标题栏',SYSMENU:'系统菜单',THICKFRAME:'可调整大小',MINIMIZEBOX:'最小化按钮',MAXIMIZEBOX:'最大化按钮',CLIPSIBLINGS:'裁剪同级窗口',CLIPCHILDREN:'裁剪子窗口',TOPMOST:'置顶',TRANSPARENT:'鼠标穿透',LAYERED:'分层窗口',TOOLWINDOW:'工具窗口',APPWINDOW:'应用窗口',CLIENTEDGE:'客户区边缘',WINDOWEDGE:'窗口边缘',NOACTIVATE:'不激活'};
      var key=String(flag||'').replace(/^WS_EX_/,'').replace(/^WS_/,'');
      return names[key]||key.replace(/_/g,' ');
    }
    function styleRow(label,hex,text){
      var flags=String(text||'').split('|').map(function(flag){return flag.trim();}).filter(function(flag){return flag&&flag!=='0';});
      var tags=flags.length?flags.map(function(flag){return'<em>'+esc(styleName(flag))+'</em>';}).join(''):'<i>无附加样式</i>';
      return'<div class="spy-detail-row spy-style-detail" data-cp="'+esc(hex||'')+'"><span>'+esc(label)+'</span><div class="spy-style-values"><strong>'+esc(hex||'-')+'</strong><div class="spy-style-tags">'+tags+'</div></div></div>';
    }
    var html='';
    html+=row('Handle',hwndHex)+row('Handle (DEC)',hwndDec)+row('Class Name',d.className||d.class)+row('Window Text',d.title);
    html+=rectRow('Rect',d.rect)+rectRow('Client Rect',d.client);
    html+=styleRow('Style',d.style,d.styleText)+styleRow('ExStyle',d.exStyle,d.exStyleText);
    html+=row('PID / TID',(d.pid||'')+' / '+(d.tid||''));
    html+=row('Parent',relation('parent'))+row('Owner',relation('owner'))+row('First Child',relation('first'))+row('Last Child',relation('last'));
    var prev=relation('prev'), next=relation('next');
    if(prev||next)html+='<div class="spy-detail-row"><span>Prev / Next</span><strong>'+esc((prev||'-')+' / '+(next||'-'))+'</strong></div>';
    html+=row('Visible',String(d.visible))+row('Enabled',String(d.enabled))+row('TopMost',String(d.topmost!=null?d.topmost:d.topMost))+row('Transparent',String(d.transparent));
    return html||'<div class="empty">没有可显示的窗口属性。</div>';
  }

  // ═══════════════════════ PROXY ═══════════════════════
  function getPathValue(obj,path){
    if(!path)return obj;
    return path.split('.').filter(Boolean).reduce(function(current,key){return current==null?undefined:current[key];},obj);
  }
  function normalizeProxyItem(item,page){
    if(typeof item==='string')return item;
    if(!item||typeof item!=='object')return'';
    var ip=item[page.data.ipField||'ip']||item.ip||item.host||item.address;
    var port=item[page.data.portField||'port']||item.port;
    var protocol=item.protocol||item.type||page.data.protocol||'http';
    return ip&&port?protocol+'://'+ip+':'+port:'';
  }
  function extractProxiesFromText(text,page){
    var format=page.data.apiFormat||'text';
    try{
      if(format==='json-array'){return JSON.parse(text).map(function(item){return normalizeProxyItem(item,page);}).filter(Boolean);}
      if(format==='json-object'){var obj=JSON.parse(text);var list=getPathValue(obj,page.data.dataField||'data')||[];return Array.isArray(list)?list.map(function(item){return normalizeProxyItem(item,page);}).filter(Boolean):[];}
      if(format==='csv'){return text.split(/\r?\n/).map(function(line){var parts=line.split(',').map(function(x){return x.trim();});if(/^ip$/i.test(parts[0]))return'';return parts[0]&&parts[1]?(page.data.protocol||'http')+'://'+parts[0]+':'+parts[1]:line.trim();}).filter(Boolean);}
      if(format==='xml'){var matches=Array.from(text.matchAll(/<proxy>[\s\S]*?<ip>(.*?)<\/ip>[\s\S]*?<port>(.*?)<\/port>[\s\S]*?<\/proxy>/gi));return matches.map(function(m){return(page.data.protocol||'http')+'://'+m[1].trim()+':'+m[2].trim();});}
      return text.split(/\r?\n/).map(function(x){return x.trim();}).filter(Boolean);
    }catch(error){page.data.error='API 解析失败：'+error.message;return[];}
  }
  async function validateProxyList(page,lines){
    page.data.running=true;page.data.error='';page.data.alive=[];page.data.dead=[];render();
    var result=await invoke('proxy_validate',{input:lines.join('\n'),maxDelayMs:String(page.data.maxDelayMs||3000),concurrency:String(page.data.concurrency||200)});
    page.data.alive=result.alive||[];page.data.dead=result.dead||[];
    page.data.result=tt('总数')+':'+(result.total||0)+' '+tt('存活')+':'+page.data.alive.length+' '+tt('死亡')+':'+page.data.dead.length+'\n\n[ALIVE]\n'+page.data.alive.map(function(p){return(p.proxy||p.raw||'')+'  '+p.latencyMs+'ms';}).join('\n')+'\n\n[DEAD]\n'+page.data.dead.map(function(p){return(p.proxy||p.raw||'')+'  '+(p.error||'dead');}).join('\n');
    page.data.running=false;
    render();return result;
  }
  function syncProxy(page){
    if($('proxyInput'))page.data.input=$('proxyInput').value;
    if($('proxyMaxDelay'))page.data.maxDelayMs=Number($('proxyMaxDelay').value||3000);
    if($('proxyConcurrency'))page.data.concurrency=Number($('proxyConcurrency').value||200);
    if($('proxyApiUrl'))page.data.apiUrl=$('proxyApiUrl').value;
    if($('proxyApiFormat'))page.data.apiFormat=$('proxyApiFormat').value;
    if($('proxyJsonDataField'))page.data.dataField=$('proxyJsonDataField').value;
    if($('proxyIpField'))page.data.ipField=$('proxyIpField').value;
    if($('proxyPortField'))page.data.portField=$('proxyPortField').value;
    if($('proxyIntervalSec'))page.data.intervalSec=Number($('proxyIntervalSec').value||10);
    if($('proxySavePath'))page.data.savePath=$('proxySavePath').value;
    if($('proxyAppendMode'))page.data.appendMode=$('proxyAppendMode').checked;
  }
  async function runProxyApi(page){
    syncProxy(page);
    if(!page.data.apiUrl)throw new Error(tt('API URL')+' '+tt('为空'));
    page.data.error='';render();
    var response=await fetch(page.data.apiUrl,{cache:'no-store'});
    var text=await response.text();
    var lines=extractProxiesFromText(text,page);
    if(!lines.length){page.data.error=tt('API 没有提取到代理');render();return null;}
    page.data.input=lines.join('\n');
    var result=await validateProxyList(page,lines);
    if(page.data.savePath&&result&&result.alive&&result.alive.length){
      await invoke('save_text',{path:page.data.savePath,text:result.alive.map(function(x){return x.proxy;}).join('\r\n')+'\r\n',append:!!page.data.appendMode});
    }
    return result;
  }
  function toggleProxyTimer(page){
    if(proxyTimers[page.id]){clearInterval(proxyTimers[page.id]);delete proxyTimers[page.id];page.data.timerEnabled=false;render();return;}
    page.data.timerEnabled=true;
    proxyTimers[page.id]=setInterval(function(){runProxyApi(page).catch(function(error){page.data.error=error.message;render();});},Math.max(1,Number(page.data.intervalSec||10))*1000);
    runProxyApi(page).catch(function(error){page.data.error=error.message;render();});
    render();
  }
  function renderProxy(page){var d=page.data;
    $('page').innerHTML='<div class="tool-page">'+renderHero(page,
      '<button class="btn primary" id="runProxyValidate">'+tt('批量验证')+'</button><button class="btn small" id="runProxyApi">'+tt('API提取验证')+'</button><button class="btn small" id="toggleProxyTimer">'+(d.timerEnabled?tt('停止定时'):tt('启动定时'))+'</button><button class="btn small" id="copyAliveProxy">'+tt('复制存活')+'</button><button class="btn small" id="clearProxyResult">'+tt('清空结果')+'</button>')+
      '<div class="grid"><div class="panel-card span-4"><div class="panel-title">'+tt('批量代理')+'</div><label>'+tt('多行代理')+'</label><textarea class="mono" style="min-height:200px" id="proxyInput" placeholder="http://1.2.3.4:8080\nsocks5://5.6.7.8:1080\n1.1.1.1:80@http">'+esc(d.input)+'</textarea><div class="two-cols"><div><label>'+tt('最大延迟 ms')+'</label><input id="proxyMaxDelay" type="number" value="'+esc(d.maxDelayMs)+'"></div><div><label>'+tt('并发')+'</label><input id="proxyConcurrency" type="number" value="'+esc(d.concurrency)+'"></div></div></div>'+
      '<div class="panel-card span-4"><div class="panel-title">'+tt('API 提取 / 定时')+'</div><label>'+tt('API URL')+'</label><input id="proxyApiUrl" value="'+esc(d.apiUrl||'')+'" placeholder="https://example.com/proxy/api"><div class="two-cols"><div><label>'+tt('格式')+'</label><select id="proxyApiFormat"><option value="auto">auto</option><option value="text">text</option><option value="json_array">json_array</option><option value="json_object">json_object</option><option value="csv">csv</option><option value="xml">xml</option></select></div><div><label>'+tt('间隔秒')+'</label><input id="proxyIntervalSec" type="number" value="'+esc(d.intervalSec)+'"></div></div><label>'+tt('JSON 数据字段')+'</label><input id="proxyJsonDataField" value="'+esc(d.jsonDataField||'data')+'" placeholder="data.proxies"><div class="two-cols"><div><label>'+tt('IP 字段')+'</label><input id="proxyIpField" value="'+esc(d.ipField||'ip')+'"></div><div><label>'+tt('端口字段')+'</label><input id="proxyPortField" value="'+esc(d.portField||'port')+'"></div></div><label>'+tt('保存路径')+'</label><input id="proxySavePath" value="'+esc(d.savePath||'./alive_proxies.txt')+'"><label class="switch-line"><span>'+tt('追加保存')+'</span><label class="switch"><input id="proxyAppendMode" type="checkbox" '+(d.appendMode?'checked':'')+'><span></span></label></label></div>'+
      '<div class="panel-card span-4"><div class="panel-title">'+tt('验证结果')+'</div><pre class="result-box">'+esc(typeof d.result==='string'?d.result||tt('等待验证...'):tt('等待验证...'))+'</pre></div></div></div>';
    if($('proxyApiFormat'))$('proxyApiFormat').value=d.apiFormat||'auto';
    if($('proxyIntervalSec'))$('proxyIntervalSec').value=d.intervalSec||10;
    if($('proxyJsonDataField'))$('proxyJsonDataField').value=d.jsonDataField||'data';
    if($('proxyIpField'))$('proxyIpField').value=d.ipField||'ip';
    if($('proxyPortField'))$('proxyPortField').value=d.portField||'port';
    if($('proxySavePath'))$('proxySavePath').value=d.savePath||'./alive_proxies.txt';
    if($('proxyAppendMode'))$('proxyAppendMode').checked=!!d.appendMode;
  }

  // ═══════════════════════ REGEX TABLE OUTPUT ═══════════════════════
  function renderRegex(page) { var d=page.data;
    $('page').innerHTML='<div class="tool-page">'+renderHero(page,
      '<button class="btn primary" id="runRegex">'+tt('匹配')+'</button><button class="btn small" id="runRegexReplace">'+tt('替换')+'</button><button class="btn small" id="copyRegexResults">'+tt('复制结果')+'</button>'+
      '<button class="btn small" id="saveRegexSnippet">'+tt('收藏')+'</button><button class="btn small" id="showRegexSnippets">'+tt('模板')+'</button>')+
      '<div class="grid"><div class="panel-card span-5"><div class="panel-title">Pattern</div>'+
      '<input class="mono" id="regexPattern" value="'+esc(d.pattern)+'">'+
      '<label>Flags</label><input class="mono" id="regexFlags" value="'+esc(d.flags)+'">'+
      '<label>Replacement <span class="tiny" style="text-transform:none">$1 $& 支持反向引用</span></label><input class="mono" id="regexReplacement" value="'+esc(d.replacement||'')+'">'+
      '<label>语法提示</label><div class="regex-syntax-help">'+
      '<div><code>\\d</code> 数字</div><div><code>\\w</code> 单词</div><div><code>\\s</code> 空白</div>'+
      '<div><code>.</code> 任意字符</div><div><code>^ $</code> 行首尾</div><div><code>\\b</code> 单词边界</div>'+
      '<div><code>+</code> 1+次</div><div><code>*</code> 0+次</div><div><code>?</code> 0或1</div>'+
      '<div><code>{n,m}</code> n~m次</div><div><code>[abc]</code> 字符组</div><div><code>[^a]</code> 排除</div>'+
      '<div><code>(?&lt;n&gt;...)</code> 命名分组</div><div><code>(?:...)</code> 非捕获</div><div><code>(?=...)</code> 前瞻</div>'+
      '<div><code>(?!...)</code> 反前瞻</div><div><code>\\1 \\2</code> 分组引用</div><div><code>$&</code> 完整匹配</div>'+
      '<div><code>g</code> 全局</div><div><code>i</code> 忽略大小写</div><div><code>m</code> 多行</div></div>'+
      '<label>代码生成</label><div class="http-code-bar" style="margin-top:0"><label class="lang-pill"><input type="radio" name="regexCodeLang" value="js" '+(d.regexCodeLang!=='py'&&d.regexCodeLang!=='cpp'&&d.regexCodeLang!=='go'&&d.regexCodeLang!=='rs'&&d.regexCodeLang!=='e'?'checked':'')+'><img class="pill-icon" src="folder_type_js.svg" onerror="this.style.display=\'none\'"><span class="pill-label">JS</span></label><label class="lang-pill"><input type="radio" name="regexCodeLang" value="py" '+(d.regexCodeLang==='py'?'checked':'')+'><img class="pill-icon" src="python.svg" onerror="this.style.display=\'none\'"><span class="pill-label">Python</span></label><label class="lang-pill"><input type="radio" name="regexCodeLang" value="go" '+(d.regexCodeLang==='go'?'checked':'')+'><img class="pill-icon" src="go.svg" onerror="this.style.display=\'none\'"><span class="pill-label">Go</span></label><label class="lang-pill"><input type="radio" name="regexCodeLang" value="rs" '+(d.regexCodeLang==='rs'?'checked':'')+'><img class="pill-icon" src="rust.svg" onerror="this.style.display=\'none\'"><span class="pill-label">Rust</span></label><label class="lang-pill"><input type="radio" name="regexCodeLang" value="cpp" '+(d.regexCodeLang==='cpp'?'checked':'')+'><img class="pill-icon" src="2.ico"><span class="pill-label">C++</span></label><label class="lang-pill"><input type="radio" name="regexCodeLang" value="e" '+(d.regexCodeLang==='e'?'checked':'')+'><img class="pill-icon" src="E.svg" onerror="this.style.display=\'none\'"><span class="pill-label">'+tt('易语言')+'</span></label><button class="btn copy-code-btn" id="copyRegexCode">'+tt('复制代码')+'</button></div></div>'+
      '<div class="panel-card span-7"><div class="panel-title">Text / Results</div>'+
      '<textarea class="mono" id="regexText" style="min-height:80px">'+esc(d.text)+'</textarea>'+
      '<div class="code-tabs" style="margin-top:8px"><button class="btn small'+(d.viewMode==='match'?' active':'')+'" data-regex-view="match">匹配结果</button><button class="btn small'+(d.viewMode==='replace'?' active':'')+'" data-regex-view="replace">替换预览</button></div>'+
      (d.viewMode==='replace'?'<div class="regex-replace-preview"><pre class="result-box">'+esc(d.replaced||'点击"替换"查看结果')+'</pre></div>':renderRegexResults(d))+
      '</div></div></div>';
  }

  function renderRegexResults(d) {
    if(d.regexError)return'<div class="tiny" style="color:var(--danger);margin-top:10px">正则错误：'+esc(d.regexError)+'</div>';
    if(!d.result||!d.result.length)return'<div class="tiny" style="margin-top:10px">点击"匹配"开始调试。</div>';
    var rows='<table class="regex-results-table"><thead><tr><th>#</th><th>Index</th><th>Match</th><th>Groups</th></tr></thead><tbody>';
    d.result.forEach(function(m,i){
      var groups='';
      if(m.groups&&typeof m.groups==='object'){
        groups=Object.keys(m.groups).map(function(k){return'<span class="regex-group-badge">'+esc(k)+': '+esc(m.groups[k])+'</span>';}).join('');
      }
      if(m.captures&&m.captures.length){
        groups+=m.captures.map(function(c,ci){return'<span class="regex-group-badge">$'+(ci+1)+': '+esc(String(c))+'</span>';}).join('');
      }
      rows+='<tr><td>'+(i+1)+'</td><td>'+m.index+'</td><td>'+esc(m.match)+'</td><td>'+(groups||'-')+'</td></tr>';
    });
    rows+='</tbody></table>';
    return rows;
  }

  // ═══════════════════════ SETTINGS / ABOUT VERTICAL ═══════════════════════
  function renderSettings(page) { var d=page.data;
    $('page').innerHTML='<div class="tool-page">'+renderHero(page,
      '<button class="btn primary" id="saveSettings">保存设置</button>')+
      '<div class="settings-vertical">'+
      '<div class="panel-card"><div class="panel-title">Appearance</div>'+
      '<div class="setting-row"><div><div class="setting-name">主题</div><div class="setting-desc">半透明毛玻璃、纯黑或珍珠白。</div></div><select id="settingTheme" class="setting-control"><option value="glass">半透明</option><option value="black">纯黑</option><option value="white">珍珠白</option></select></div>'+
      '<div class="setting-row"><div><div class="setting-name">字体大小</div><div class="setting-desc">调整界面密度（11-18）。</div></div><input id="settingFont" type="number" min="11" max="18" value="'+esc(d.fontSize)+'" class="setting-control"></div></div>'+
      '<div class="panel-card"><div class="panel-title">System</div>'+
      '<div class="setting-row"><div><div class="setting-name">开机启动</div><div class="setting-desc">Windows 登录后自动启动本程序。</div></div><label class="switch"><input id="settingStartup" type="checkbox" '+(d.startup?'checked':'')+'><span></span></label></div></div>'+
      '</div></div>';
    if($('settingTheme'))$('settingTheme').value=d.theme;
  }

  function renderAbout(page) {
    $('page').innerHTML='<div class="tool-page">'+renderHero(page,'')+
      '<div class="about-pro">'+
      '<div class="about-hero">'+
      '<div class="about-avatar"><svg viewBox="0 0 64 64"><rect width="64" height="64" rx="18" fill="url(#aGrad)"/><text x="32" y="44" text-anchor="middle" fill="#fff" font-size="26" font-weight="900">PS</text><defs><linearGradient id="aGrad" x1="0" y1="0" x2="64" y2="64"><stop stop-color="var(--accent)"/><stop offset="1" stop-color="var(--accent-2)"/></linearGradient></defs></svg></div>'+
      '<div class="about-hero-text"><div class="about-hero-name">'+JADE.d('JPJ:eJa:JnJu:JtJ J:SJoJfJt')+'</div><div class="about-hero-desc">独立开发者 | Full-Stack Developer</div></div>'+
      '</div>'+
      '<div class="about-links">'+
      '<div class="about-link copyable" data-cp="'+JADE.d('J2J:4J5:J8J6:J7')+'"><div class="about-link-icon"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3 9h18" stroke="currentColor" stroke-width="1.2"/></svg></div><div class="about-link-info"><span>QQ</span><strong>'+JADE.d('J2J:4J5:J8J6:J7')+'</strong></div></div>'+
      '<div class="about-link copyable" data-cp="'+JADE.d('J1J:1J0:J3J4:J2J6J:3J0J2')+'"><div class="about-link-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></div><div class="about-link-info"><span>QQ群</span><strong>'+JADE.d('J1J:1J0:J3J4:J2J6J:3J0J2')+'</strong></div></div>'+
      '<div class="about-link"><div class="about-link-icon"><svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 21h8M12 17v4" stroke="currentColor" stroke-width="1.5"/></svg></div><div class="about-link-info"><span>项目</span><strong>Jade 编程助手 v1.3</strong></div></div>'+
      '<div class="about-link"><div class="about-link-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 2a10 10 0 0 1 0 20M12 2a10 10 0 0 0 0 20M2 12h20" stroke="currentColor" stroke-width="1.2"/></svg></div><div class="about-link-info"><span>运行时</span><strong>JadeView + C++17 + WebView2</strong></div></div>'+
      '</div>'+
      '<div class="about-footer"><span>'+JADE.d('J©J: J2:J0J2:J6J J:PJeJaJn:JuJtJ JSJo:JfJtJ.J JAJlJlJ: JrJi:JgJhJtJsJ JrJeJsJe:JrJ:vJeJdJ.')+'</span><span>Built with ❤ using JadeView</span></div>'+
      '</div></div>';
  }

  // showModal/closeModal now via JADE namespace

  function showSettingsModal() {
    showModal('<div class="modal-head"><div class="modal-title">⚙ '+tt('设置')+'</div><button class="modal-close" id="closeModal">×</button></div>'+
      '<div class="modal-body-stack">'+
      '<div class="settings-2col">'+
      '<div class="modal-section"><h3>'+tt('外观')+'</h3>'+
      '<div class="modal-row"><div class="modal-row-label">'+tt('主题')+'</div><select id="modalTheme" class="modal-control"><option value="glass">'+tt('半透明毛玻璃')+'</option><option value="black">'+tt('纯黑')+'</option><option value="white">'+tt('珍珠白')+'</option></select></div>'+
      '<div class="modal-row"><div class="modal-row-label">'+tt('语言')+'</div><select id="modalLang" class="modal-control"><option value="zh">'+tt('中文')+'</option><option value="en">'+tt('English')+'</option></select></div>'+
      '<div class="modal-row"><div class="modal-row-label">'+tt('字体大小')+'</div><div class="modal-control-sm"><input id="modalFontSize" type="range" min="11" max="18" value="'+esc(localStorage.getItem('fontSize')||13)+'"><span id="fontSizeValue">'+(localStorage.getItem('fontSize')||13)+'px</span></div></div>'+
      '</div>'+
      '<div class="modal-section"><h3>'+tt('系统')+'</h3>'+
      '<div class="modal-row"><div class="modal-row-label">'+tt('字体')+'</div><select id="modalFont" class="modal-control"><option>'+tt('加载字体中...')+'</option></select></div>'+
      '<div class="modal-row"><div class="modal-row-label">'+tt('开机启动')+'</div><label class="switch"><input id="modalStartup" type="checkbox" '+(localStorage.getItem('startup')==='1'?'checked':'')+'><span></span></label></div>'+
      '</div>'+
      '</div>'+
      '<div class="modal-section"><h3>'+tt('快捷键')+'</h3>'+
      '<div class="kbd-grid"><div class="kbd-item"><span>'+tt('发送请求')+'</span><kbd>Ctrl+Enter</kbd></div><div class="kbd-item"><span>'+tt('新建页面')+'</span><kbd>Ctrl+T</kbd></div><div class="kbd-item"><span>'+tt('关闭页面')+'</span><kbd>Ctrl+W</kbd></div><div class="kbd-item"><span>'+tt('切换页面')+'</span><kbd>Ctrl+Tab</kbd></div><div class="kbd-item"><span>'+tt('刷新数据')+'</span><kbd>Ctrl+R</kbd></div><div class="kbd-item"><span>'+tt('切标签')+'</span><kbd>Ctrl+1~0</kbd></div></div>'+
      '</div>'+
      '<button class="btn primary" id="saveModalSettings" style="width:100%;margin-top:8px;height:40px;font-size:14px">' + tt('保存') + '</button>'+
      '</div>');
    $('modalTheme').value=state.theme;$('modalLang').value=lang;
    var fsEl=$('modalFontSize');if(fsEl)fsEl.addEventListener('input',function(){var v=$('modalFontSize').value;$('fontSizeValue').textContent=v+'px';});
    invoke('get_fonts',{}).then(function(res){var data=typeof res==='string'?JSON.parse(res):res;var current=localStorage.getItem('fontFamily')||'Microsoft YaHei UI';$('modalFont').innerHTML=(data.fonts||[]).map(function(f){return'<option value="'+esc(f)+'">'+esc(f)+'</option>';}).join('');$('modalFont').value=current;}).catch(function(){$('modalFont').innerHTML='<option>Microsoft YaHei UI</option><option>Segoe UI</option><option>Consolas</option>';});
  }

  function showAboutModal() {
    showModal('<div class="modal-head"><div class="modal-title">'+tt('关于')+'</div><button class="modal-close" id="closeModal">×</button></div>'+
      '<div class="about-dialog">'+
      '<div class="about-hero-center">'+
      '<img class="about-icon-big-img" src="b6.ico" width="56" height="56" onerror="this.style.display=\'none\'">'+
      '<div class="about-title-row"><h2 class="about-title-big">Jade '+tt('编程助手')+'</h2><div class="about-ver-badge">v1.3</div></div>'+
      '</div>'+
      '<div class="about-divider"></div>'+
      '<div class="about-meta-cards">'+
      '<div class="about-meta-card click-copy" data-cp="花老板"><div class="amc-icon dev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg></div><div class="amc-info"><span>'+tt('开发者')+'</span><strong>花老板</strong></div></div>'+
      '<div class="about-meta-card click-copy" data-cp="'+JADE.d('J2J:4J5:J8J6:J7')+'"><div class="amc-icon qq"><img src="QQ.ico" width="20" height="20" style="display:block" onerror="this.style.display=\'none\'"></div><div class="amc-info"><span>QQ</span><strong>'+JADE.d('J2J:4J5:J8J6:J7')+'<small>'+tt('点击复制')+'</small></strong></div></div>'+
      '<div class="about-meta-card" id="openQQGroup"><div class="amc-icon group"><svg viewBox="0 0 1024 1024" width="20" height="20"><path d="M939 480c1-49-7-133-53-190-28-34-64-54-109-60 7 15 12 31 16 46 24 7 45 20 61 40 39 48 44 123 44 163a41 41 0 0 0 12 30c6 7 32 30 36 111a27 27 0 0 1-4-2 41 41 0 0 0-56 3 42 42 0 0 0-1 57c3 3 11 13 15 20 1 2 1 4 1 6-1 3-6 7-13 11-22 9-41 14-56 14-6 0-12-1-17-1 4 12 7 28 8 42 3 0 6 1 9 1 22 0 46-7 71-17 20-8 33-22 38-39a50 50 0 0 0-6-38c-7-13-19-26-19-26a56 56 0 0 0 35 14 45 45 0 0 0 17-3c11-5 18-19 19-30l1-2c-3-99-34-135-48-149zm-738 290c0-13 2-29 7-42a127 127 0 0 1-17 1c-17 0-35-4-53-10a25 25 0 0 1-16-16c0-2 0-4 2-8l6-9a58 58 0 0 1 6-10 42 42 0 0 0-2-55 41 41 0 0 0-54-5l-2 1c-4-68 29-98 36-105a42 42 0 0 0 12-30c-1-50 6-120 43-166 15-19 36-31 59-38a297 297 0 0 1 18-47c-45 5-81 25-109 59-44 55-53 134-52 193-16 16-57 61-47 148l1 6a33 33 0 0 0 10 19 31 31 0 0 0 24 9c11-1 31-15 31-15-8 10-9 13-15 23a50 50 0 0 0-7 41c5 18 20 36 41 44 25 10 48 13 68 13 4 0 7 0 10-1zm-18-107a22 22 0 0 0 1 4l1 4c1 6 3 17 13 26a43 43 0 0 0 34 12c15-1 42-21 42-21-11 14-12 18-21 32a69 69 0 0 0-8 56c6 24 26 49 55 60a260 260 0 0 0 94 18c48 0 84-14 101-23a34 34 0 0 1 16-4c5 0 10 1 16 4 14 8 52 23 101 23 30 0 64-9 99-23 27-12 45-30 51-53a68 68 0 0 0-8-53c-9-17-26-36-26-36 13 11 30 20 49 20 7 0 14-2 22-5 16-6 25-25 27-41l1-3c-4-135-47-193-67-212 1-68-9-182-73-261-46-56-110-84-190-84H509c-80 0-143 28-189 84-61 75-73 183-72 264-22 22-78 92-65 212zm-89-130a40 40 0 0 0 11-28c-1-68 9-161 59-224 36-43 84-65 148-65h4c64 0 113 22 148 65 54 67 62 167 61 221a39 39 0 0 0 12 29c9 9 47 51 50 171a19 19 0 0 1-2 6 19 19 0 0 1-5 1 36 36 0 0 1-22-10 39 39 0 0 0-52 3 40 40 0 0 0-2 53c4 5 15 18 21 29 4 5 5 12 3 18-2 10-11 18-26 24-30 13-56 19-77 19-39 0-69-12-77-16a69 69 0 0 0-34-10 71 71 0 0 0-32 8c-13 7-40 18-78 18-24 0-49-5-74-15a47 47 0 0 1-29-30 26 26 0 0 1 4-21l7-12c3-5 4-8 10-15a40 40 0 0 0-2-51 39 39 0 0 0-51-6c-7 5-17 11-22 13l-1-1a45 45 0 0 1-1-5 70 70 0 0 0-1-4c-10-100 38-154 50-167z" fill="#1f8bff"/></svg></div><div class="amc-info"><span>QQ '+tt('群')+'</span><strong>'+JADE.d('J1J:1J0:J3J4:J2J6J:3J0J2')+'<small>'+tt('点击加入')+'</small></strong></div></div>'+
      '<div class="about-meta-card"><div class="amc-icon runtime"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg></div><div class="amc-info"><span>Runtime</span><strong>JadeView + C++17 + WebView2</strong></div></div>'+
      '</div>'+
      '<div class="about-divider"></div>'+
      '<div class="about-footer">© 2026 Programmer Assistant · Built with ❤</div>'+
      '</div>');
  }

  // ═══════════════════════ EVENT HANDLING ═══════════════════════
  document.addEventListener('click', function (event) {
    $('contextMenu').classList.remove('show');
    $('procContextMenu').classList.remove('show');
    var winBtn=event.target.closest('[data-window]');
    var themeBtn=event.target.closest('#themeToggle');
    if(event.target.closest('#runInternalTests')){runInternalTests();return;}
    if(winBtn){invoke('window_control',{action:winBtn.dataset.window}).catch(function(){});return;}
    if(themeBtn){var themes=['glass','black','white'];var idx=themes.indexOf(state.theme);state.theme=themes[(idx+1)%3];localStorage.setItem('theme',state.theme);invoke('apply_theme',{theme:state.theme}).catch(function(){});render();return;}
    if(event.target.closest('#openSettings')){showSettingsModal();return;}
    if(event.target.closest('#openAbout')){showAboutModal();return;}
    if(event.target.closest('#openQQGroup')){window.open('https://qm.qq.com/q/Fv9KjpGCEq','_blank');return;}
    if(event.target.closest('#closeModal')||event.target.id==='modalMask'){closeModal();return;}
    if(event.target.id==='saveModalSettings'){state.theme=$('modalTheme').value;lang=$('modalLang').value;var font=$('modalFont').value;var size=$('modalFontSize').value||13;var startup=$('modalStartup').checked;localStorage.setItem('theme',state.theme);localStorage.setItem('lang',lang);localStorage.setItem('fontFamily',font);localStorage.setItem('fontSize',size);localStorage.setItem('startup',startup?'1':'0');document.documentElement.style.setProperty('font-size',size+'px','important');document.documentElement.style.setProperty('font-family','"'+font+'","Microsoft YaHei UI","Segoe UI",Arial,sans-serif','important');invoke('apply_theme',{theme:state.theme}).catch(function(){});invoke('set_startup',{enabled:startup}).catch(function(){});closeModal();render();return;}
    var tool=event.target.closest('.tool-item');
    if(tool){var page=state.pages.find(function(p){return p.type===tool.dataset.type;});state.activeId=page?page.id:null;if(!page)createPage(tool.dataset.type);else render();return;}
    var tab=event.target.closest('.tab');
    if(tab){state.activeId=tab.dataset.id;render();return;}
    var page=activePage();if(!page)return;
    // HTTP
    if(event.target.dataset.addKv){syncHttp(page);page.data[event.target.dataset.addKv].push({key:'',value:''});renderHttp(page);}
    if(event.target.dataset.removeKv){syncHttp(page);page.data[event.target.dataset.removeKv].splice(Number(event.target.dataset.index),1);renderHttp(page);}
    if(event.target.dataset.responseView){page.data.responseView=event.target.dataset.responseView;renderHttp(page);}
    if(event.target.id==='sendHttp'||event.target.id==='sendHttp2')sendHttp(page);
    if(event.target.id==='importCurl')importCurl(page);
    if(event.target.id==='copyHttpResult')copyText(page.data.result);
    if(event.target.id==='copyHttpCode'){
      syncHttp(page);
      var codeLang=document.querySelector('input[name="httpCodeLang"]:checked');
      page.data.codeLang=codeLang?codeLang.value:'e';
      showHttpCodeModal(page);
    }
    if(event.target.id==='copyModalCode'){
      var modalPre=document.querySelector('#httpCodeModal');
      copyText(modalPre?modalPre.textContent:'');
      closeModal();
    }
    if(event.target.name==='eHttpMode'){
      var emod=document.querySelector('input[name="eHttpMode"]:checked');
      if(emod&&page)page.data.eHttpMode=emod.value;
      updateEModeCode();
    }
    if(event.target.id==='saveFavorite'){
      var name=prompt('收藏名称：',page.data.method+' '+page.data.url.slice(0,40));
      if(!name)return;
      var favs=JSON.parse(localStorage.getItem('httpFavorites')||'[]');favs.unshift({name:name,method:page.data.method,url:page.data.url,headers:page.data.headers,body:page.data.body,useNative:page.data.useNative,protocol:page.data.protocol});
      localStorage.setItem('httpFavorites',JSON.stringify(favs.slice(0,50)));
    }
    if(event.target.id==='showHttpSnippets'){
      var favs=JSON.parse(localStorage.getItem('httpFavorites')||'[]');
      showModal('<div class="modal-head"><div class="modal-title">请求模板 ('+favs.length+')</div><button class="modal-close" id="closeModal">×</button></div><div class="info-list">'+(favs.length?favs.map(function(f,i){return'<div class="info-item"><span>'+esc(f.name||'')+' <span class="tiny">'+esc(f.method||'')+'</span></span><strong>'+esc((f.url||'').slice(0,60))+'<br><button class="btn small" data-use-http-snippet="'+i+'">加载</button> <button class="btn small" data-del-http-snippet="'+i+'" style="color:var(--danger)">删除</button></strong></div>';}).join(''):'<div class="tiny">暂无收藏模板</div>')+'</div>');
    }
    var useHttpSn=event.target.dataset.useHttpSnippet;
    if(useHttpSn!==undefined){
      var favs2=JSON.parse(localStorage.getItem('httpFavorites')||'[]');
      var sn=favs2[Number(useHttpSn)];
      if(sn){page.data.method=sn.method||'GET';page.data.url=sn.url||'';page.data.headers=sn.headers||[];page.data.body=sn.body||'';page.data.useNative=sn.useNative!==false;page.data.protocol=sn.protocol||'auto';closeModal();renderHttp(page);}
    }
    var delHttpSn=event.target.dataset.delHttpSnippet;
    if(delHttpSn!==undefined){
      var favs3=JSON.parse(localStorage.getItem('httpFavorites')||'[]');favs3.splice(Number(delHttpSn),1);localStorage.setItem('httpFavorites',JSON.stringify(favs3));closeModal();if(page.type==='http'){$('showHttpSnippets').click();}
    }
    if(event.target.id==='showHistory'){
      var hist=JSON.parse(localStorage.getItem('httpHistory')||'[]');
      showModal('<div class="modal-head"><div class="modal-title">请求历史 ('+hist.length+')</div><button class="modal-close" id="closeModal">×</button></div>'+
        (hist.length?('<div class="info-list" id="httpHistList" style="max-height:56vh;overflow:auto;padding-right:4px">'+
          hist.map(function(h,i){return '<div class="info-item" data-load-http-hist="'+i+'" title="点击加载此请求" style="cursor:pointer;align-items:center;gap:12px">'+
            '<span style="white-space:nowrap;text-align:left"><b style="color:var(--accent);font-size:12px">'+esc(h.method||'')+'</b><br>'+esc(new Date(h.time).toLocaleString())+(h.useNative?'<br>原生':'')+'</span>'+
            '<strong style="flex:1;min-width:0;font-weight:500;word-break:break-all;text-align:left">'+esc(String(h.status||'-'))+' · '+esc(h.url||'')+'</strong>'+
            '<span style="white-space:nowrap;display:flex;gap:6px"><button class="btn small" data-load-http-hist="'+i+'">加载</button><button class="btn small" data-del-http-hist="'+i+'" style="color:var(--danger)">删除</button></span>'+
          '</div>';}).join('')+
          '</div><div style="margin-top:10px;text-align:right"><button class="btn small" id="clearHttpHistory" style="color:var(--danger)">清空全部</button></div>')
        :'<div class="tiny">暂无历史</div>'));
    }
    var loadHist=event.target.closest&&event.target.closest('[data-load-http-hist]');
    if(loadHist&&!(event.target.closest&&event.target.closest('[data-del-http-hist]'))){
      var hl=JSON.parse(localStorage.getItem('httpHistory')||'[]');var hh=hl[Number(loadHist.dataset.loadHttpHist)];
      if(hh){page.data.method=hh.method||'GET';page.data.url=hh.url||'';page.data.headers=hh.headers||'';page.data.body=hh.body||'';page.data.proxy=hh.proxy||'';page.data.protocol=hh.protocol||'auto';page.data.useNative=!!hh.useNative;closeModal();renderHttp(page);}
    }
    var delHist=event.target.closest&&event.target.closest('[data-del-http-hist]');
    if(delHist){
      var dl=JSON.parse(localStorage.getItem('httpHistory')||'[]');dl.splice(Number(delHist.dataset.delHttpHist),1);localStorage.setItem('httpHistory',JSON.stringify(dl));closeModal();if(page.type==='http')$('showHistory').click();
    }
    if(event.target.id==='clearHttpHistory'){localStorage.removeItem('httpHistory');closeModal();}
    // WebSocket
    if(event.target.id==='connectWs'){
      page.data.url=$('wsUrl').value;page.data.message=$('wsMessage').value;
      page.data.autoJson=$('wsAutoJson').checked;page.data.reconnect=$('wsReconnect').checked;
      if($('wsCookie'))page.data.cookie=$('wsCookie').value;
      if($('wsHeaders'))page.data.headers=$('wsHeaders').value;
      // 先清理两种后端的旧连接
      if(wsMap[page.id]){try{wsMap[page.id].close();}catch(e){}}wsMap[page.id]=null;
      if(wsNative[page.id]){wsNativeClose(page);}
      // 携带 cookie / 自定义头 → 走原生 WinHTTP；否则用浏览器 WebSocket
      if(wsUseNative(page)){wsNativeConnect(page);return;}
      page.data.log='';page.data.state='connecting';
      wsAppend(page,'CONNECTING → '+page.data.url);
      wsAppend(page,'  后端=浏览器WebSocket（不可带 cookie/自定义头；需要鉴权请填 Cookie 走原生）');
      renderWs(page);
      var s=wsMap[page.id]=new WebSocket(page.data.url);
      s.onopen=function(){page.data.state='open';wsAppend(page,'OPEN 已连接 ✓  后端=浏览器WebSocket  子协议='+(s.protocol||'-'));renderWs(page);};
      s.onmessage=function(e){wsAppend(page,'RECV ('+((e.data&&e.data.length)||0)+'B) '+e.data);};
      s.onerror=function(e){page.data.state='error';wsAppend(page,'ERROR 连接出错（检查 URL/网络/证书/域名解析；浏览器后端拿不到详细错误码）');renderWs(page);};
      s.onclose=function(e){if(page.data.state!=='error')page.data.state='closed';wsAppend(page,'CLOSE code='+e.code+'  reason='+(e.reason||(e.code===1006?'异常关闭/无法建立连接':'(无)'))+(page.data.reconnect?'  → 1.5s 后自动重连…':''));wsMap[page.id]=null;renderWs(page);if(page.data.reconnect){setTimeout(function(){if(activePage()&&activePage().id===page.id){var btn=$('connectWs');if(btn)btn.click();}},1500);}};
    }
    if(event.target.id==='clearWsLog'){page.data.log='';renderWs(page);}
    if(event.target.id==='closeWs'){page.data.reconnect=false;
      if(wsNative[page.id]){wsNativeClose(page);}
      else if(wsMap[page.id]){try{wsMap[page.id].close(1000,'manual close');}catch(e){}wsAppend(page,'CLOSE requested');}
      else{wsAppend(page,'WARN no active socket');}
    }
    if(event.target.id==='pingWs'){
      var pingMsg='ping '+Date.now();
      if(wsNative[page.id]){wsNativeSend(page,pingMsg);}
      else if(wsMap[page.id]&&wsMap[page.id].readyState===WebSocket.OPEN){try{wsMap[page.id].send(pingMsg);wsAppend(page,'PING '+pingMsg);}catch(e){wsAppend(page,'PING FAILED: '+e.message);}}
      else{wsAppend(page,'WARN socket not open, ping skipped. Please connect first.');}
    }
    if(event.target.id==='sendWs'||event.target.id==='sendWs2'){
      page.data.message=$('wsMessage')?$('wsMessage').value:page.data.message;
      page.data.autoJson=$('wsAutoJson')?$('wsAutoJson').checked:page.data.autoJson;
      var msg=page.data.message;
      if(page.data.autoJson){try{msg=JSON.stringify(JSON.parse(msg));}catch(e){wsAppend(page,'WARN JSON minify failed: '+e.message);return;}}
      if(wsNative[page.id]){wsNativeSend(page,msg);}
      else if(wsMap[page.id]&&wsMap[page.id].readyState===WebSocket.OPEN){try{wsMap[page.id].send(msg);wsAppend(page,'SEND '+msg);}catch(e){wsAppend(page,'ERROR send failed: '+e.message);}}
      else{wsAppend(page,'WARN socket not open, send skipped. Please connect first.');}
    }
    if(event.target.id==='copyWsLog')copyText(page.data.log);
    // Encoding
    if(event.target.id==='convertEncoding'){page.data.input=$('encodingInput').value;page.data.target=$('encodingTarget').value;convertOneEncoding(page,page.data.target).then(function(data){page.data.result=page.data.target==='hex-decode'?hexDecodeDetail(page.data.input):String(data.output||'');renderEncoding(page);}).catch(function(e){page.data.result='转换失败：'+e.message;renderEncoding(page);});}
    if(event.target.id==='convertAllEncoding'){runAllEncodingTransforms(page);}
    if(event.target.id==='copyEncoding')copyText(page.data.result);
    if(event.target.id==='copyEncCode'){
      var ecl=document.querySelector('input[name="encCodeLang"]:checked');ecl=ecl?ecl.value:'cpp';
      page.data.encCodeLang=ecl;
      var r=page.data.result||''; var t=page.data.target||'';
      var code=''; var escaped=r.replace(/\\/g,'\\\\').replace(/"/g,'\\"');
      if(ecl==='e'){code='.版本 2\n\n.局部变量 result, 文本型\nresult ＝ "'+escaped+'"\n调试输出 (result)';}
      else if(ecl==='py'){code='# Python\nresult = """'+r+'"""\nprint(result)';}
      else if(ecl==='cpp'){code='#include <iostream>\n#include <string>\n\nint main() {\n  std::string result = "'+escaped+'";\n  std::cout << result << std::endl;\n  return 0;\n}';}
      else if(ecl==='go'){code='package main\n\nimport "fmt"\n\nfunc main() {\n  result := `'+r+'`\n  fmt.Println(result)\n}';}
      else if(ecl==='rs'){code='fn main() {\n  let result = r#"'+r+'"#;\n  println!("{}", result);\n}';}
      else if(ecl==='js'){code='// JavaScript\nconst result = `'+r+'`;\nconsole.log(result);';}
      var langNames={e:tt('易语言'),py:'Python',cpp:'C++',go:'Go',rs:'Rust',js:'JavaScript'};
      showModal('<div class="modal-head"><div class="modal-title">'+tt('生成代码')+' ('+(langNames[ecl]||ecl)+')</div><button class="modal-close" id="closeModal">×</button></div><pre class="result-box" style="min-height:100px;max-height:50vh;padding:12px;background:rgba(0,0,0,0.3);border-radius:10px">'+esc(code||tt('无输出数据'))+'</pre><button class="btn primary copy-code-btn" data-cp="'+esc(code)+'" style="margin-top:10px;width:100%">📋 '+tt('复制到剪贴板')+'</button>');
    }
    // JSON
    if(event.target.id==='formatJson')parseJson(page,false);
    if(event.target.id==='parseJson')parseJson(page,false);
    if(event.target.id==='minifyJson')parseJson(page,true);
    if(event.target.id==='copyJson')copyText(page.data.output);
    var treeNode=event.target.closest('[data-tree-index]');
    if(treeNode){var node=page.data.tree[Number(treeNode.dataset.treeIndex)];page.data.selectedPath=node.path;page.data.code=makeZyCode(node.path,page.data.codeLang,currentLib(page.data));renderJson(page);}
    var langBtn=event.target.closest?event.target.closest('[data-code-lang]'):null;
    if(langBtn){page.data.codeLang=langBtn.dataset.codeLang;page.data.code=makeZyCode(page.data.selectedPath||'$',page.data.codeLang,currentLib(page.data));renderJson(page);}
    var libBtn=event.target.closest?event.target.closest('[data-code-lib]'):null;
    if(libBtn){if(!page.data.codeLibs)page.data.codeLibs={};page.data.codeLibs[page.data.codeLang]=libBtn.dataset.codeLib;page.data.code=makeZyCode(page.data.selectedPath||'$',page.data.codeLang,libBtn.dataset.codeLib);renderJson(page);}
    if(event.target.id==='showZyCode'){
      var code=page.data.code||makeZyCode(page.data.selectedPath||'$',page.data.codeLang||'cpp',currentLib(page.data));
      var langNames={cpp:'C++',py:'Python',js:'JavaScript',go:'Go',rs:'Rust',e:tt('易语言')};
      var _lc=page.data.codeLang||'cpp',_lib=currentLib(page.data),_libObj=(JSON_LIBS[_lc]||[]).filter(function(l){return l.id===_lib;})[0];
      showModal('<div class="modal-head"><div class="modal-title">'+tt('生成代码')+' ('+(langNames[_lc]||_lc)+(_libObj?' · '+_libObj.name:'')+')</div><button class="modal-close" id="closeModal">×</button></div><pre class="result-box" style="min-height:120px;max-height:50vh;padding:12px;background:rgba(0,0,0,0.3);border-radius:10px">'+esc(code||tt('解析后选择树节点生成代码'))+'</pre><button class="btn primary copy-code-btn" id="copyModalZyCode" data-cp="'+esc(code||'')+'" style="margin-top:10px;width:100%">📋 '+tt('复制到剪贴板')+'</button>');
    }
    if(event.target.id==='copyZyCode')copyText(page.data.code);
    if(event.target.id==='jsonDiff'){
      var currentJson=(page.data.output||'').replace(/^JSON 错误.*/,'');
      showModal('<div class="modal-head"><div class="modal-title">JSON Diff</div><button class="modal-close" id="closeModal">×</button></div><div class="split-output"><div><label>JSON A (当前)</label><textarea class="mono" id="diffJsonA" style="min-height:200px">'+esc(currentJson)+'</textarea></div><div><label>JSON B (对比)</label><textarea class="mono" id="diffJsonB" style="min-height:200px" placeholder="粘贴要对比的 JSON..."></textarea></div></div><button class="btn primary" id="runJsonDiff" style="margin-top:10px">执行 Diff</button><pre class="result-box" id="jsonDiffResult" style="margin-top:8px;min-height:100px">点击"执行 Diff"查看差异。</pre>');
    }
    if(event.target.id==='runJsonDiff'){
      var aText=($('diffJsonA')||{}).value||'';
      var bText=($('diffJsonB')||{}).value||'';
      var result='';
      try{
        var a=JSON.parse(aText);var b=JSON.parse(bText);
        var diffs=jsonDeepDiff(a,b,'$');
        result=diffs.length?diffs.join('\n'):'两个 JSON 完全一致。';
      }catch(e){result='JSON 解析错误：'+e.message;}
      if($('jsonDiffResult'))$('jsonDiffResult').textContent=result;
    }
    // Calculator
    if(event.target.id==='runCalc')runCalc(page);
    if(event.target.dataset.calcKey){page.data.expr=($('calcExpression').value||'')+event.target.dataset.calcKey;renderCalculator(page);}
    if(event.target.id==='calcClear'){page.data.expr='0';page.data.value=0;renderCalculator(page);}
    if(event.target.dataset.calcOp){var op=event.target.dataset.calcOp;var current=BigInt(Math.trunc(Number(page.data.value||0)));if(op==='not'){var m=maskFor(page.data.word);page.data.value=Number((~current)&m);if(!isFinite(page.data.value))page.data.value=0;page.data.expr=String(page.data.value);}else page.data.expr='('+$('calcExpression').value+') '+({and:'&',or:'|',xor:'^',lsh:'<<',rsh:'>>'})[op]+' ';renderCalculator(page);}
    if(event.target.id==='copyCalc')copyText(JSON.stringify(calcDisplay(page.data),null,2));
    // MSAA
    if(event.target.id==='inspectMsaa'){page.data.hwnd=$('msaaHwnd').value;page.data.result='解析中...';renderMsaa(page);invoke('inspect_msaa',{hwnd:page.data.hwnd}).then(function(res){var data=parseMaybeJson(res);var count=data.nodeCount||0;var src=data.accessibleSource?('，来源 '+data.accessibleSource):'';page.data.result=data.tree?('解析完成：'+count+' 节点'+src+(data.truncated?'，已截断（上限 '+(data.maxNodes||'')+'）':'')):'解析完成 (无 MSAA 树)';page.data.tree=data.tree||null;page.data.selectedNode=page.data.tree;page.data.selectedPath='0';renderMsaa(page);}).catch(function(e){page.data.result='解析失败：'+e.message;page.data.tree=null;renderMsaa(page);});}
    var msaaNode=event.target.closest('.msaa-node');
    if(msaaNode){
      // 选中节点
      page.data.selectedPath=msaaNode.dataset.msaaPath;
      page.data.selectedNode=getTreeNodeByPath(page.data.tree,page.data.selectedPath);
      // 点击 twist 区域时折叠/展开
      if(event.target.classList.contains('msaa-twist')||event.target.closest('.msaa-twist')){
        var children=msaaNode.nextElementSibling;
        if(children&&children.classList.contains('msaa-children')){
          var hidden=children.style.display==='none';
          children.style.display=hidden?'':'none';
          msaaNode.classList.toggle('open',hidden);
          var twist=msaaNode.querySelector('.msaa-twist');
          if(twist)twist.textContent=hidden?'▼':'▶';
        }
      }
      renderMsaaDetailPart(page); // 只更新详情，不重建整棵树
      return;
    }
    if(event.target.id==='copyMsaa')copyText(page.data.result||renderMsaaText(page.data.tree));
    // Process
    if(event.target.id==='refreshProcess'){ refreshProcessTbody(page); }
    if(event.target.id==='hideSysProc'){
      page.data._hideSystem=event.target.checked;
      var allItems=page.data.result||[];
      var checked=!!event.target.checked;
      var sysCount=checked?allItems.filter(function(p){return isSystemProc(p);}).length:0;
      updateProcessStats(page);
      updateProcessTable(page,true);
      // 更新badge文字（不重建label）
      var badge=document.querySelector('.proc-filter-badge');
      if(checked&&sysCount){if(badge)badge.textContent=sysCount; else{var lb=event.target.parentNode;if(lb){var s=document.createElement('span');s.className='proc-filter-badge';s.textContent=sysCount;lb.appendChild(s);}}}
      else{if(badge)badge.remove();}
    }
    if(event.target.id==='procSearch'){
      page.data._procSearch=event.target.value;
      updateProcessStats(page);
      updateProcessTable(page,true);
    }
    // Process row click - select row
    var procRow=event.target.closest('.proc-row');
    if(procRow){
      var sel=document.querySelector('.proc-row.selected');
      if(sel&&sel!==procRow)sel.classList.remove('selected');
      procRow.classList.toggle('selected');
    }
    // Process context menu (right-click)
    if(event.target.closest('#procContextMenu')){
      var sel2=document.querySelector('.proc-row.selected');
      if(event.target.dataset.action==='proc-kill'&&sel2){
        var kpid=sel2.dataset.procPid;
        invoke('kill_process',{pid:kpid}).then(function(res){var data=parseMaybeJson(res);if(data.ok)sel2.remove();else alert('失败：'+(data.error||'unknown'));}).catch(function(e){alert('终止失败：'+e.message);});
        $('procContextMenu').classList.remove('show');
      }
      if(event.target.dataset.action==='proc-open'&&sel2){
        invoke('open_process_path',{pid:sel2.dataset.procPid,path:sel2.dataset.procPath}).catch(function(){});
        $('procContextMenu').classList.remove('show');
      }
      if(event.target.dataset.action==='proc-hexpid'&&sel2){
        // 切换整个列表 PID 显示 10←→16进制
        page.data._showHex=!page.data._showHex;
        updateProcessTable(page,true);
        // 更新菜单文字
        var hexBtn=$('procHexPidAction');if(hexBtn)hexBtn.textContent=page.data._showHex?tt('显示10进制PID'):tt('显示16进制PID');
        $('procContextMenu').classList.remove('show');
      }
      if(event.target.dataset.action==='proc-icon'&&sel2){
        invoke('save_proc_icon',{pid:sel2.dataset.procPid,path:sel2.dataset.procPath}).then(function(res){
          var d=parseMaybeJson(res);
          if(d&&d.ok){/* saved */}else alert('失败：'+(d?d.error:'unknown'));
        }).catch(function(e){alert('失败：'+e.message);});
        $('procContextMenu').classList.remove('show');
      }
      if(event.target.dataset.action==='proc-copy'&&sel2){
        copyText(sel2.dataset.procName+' PID='+sel2.dataset.procPid+' Path='+(sel2.dataset.procPath||''));
        $('procContextMenu').classList.remove('show');
      }
      return;
    }
    // Color
    if(event.target.id==='pickScreenColor'){
      invoke('pick_screen_color',{}).then(function(res){
        var data=parseMaybeJson(res);
        if(data.hex){
          page.data.color=data.hex;page.data.result=data.hex+' at '+data.x+','+data.y;
          // 自动存入记录（去重）
          if(!page.data.history)page.data.history=[];
          var exists=false;
          for(var i=0;i<page.data.history.length;i++){if(page.data.history[i].toUpperCase()===data.hex.toUpperCase()){exists=true;break;}}
          if(!exists){page.data.history.unshift(data.hex);if(page.data.history.length>50)page.data.history.pop();}
        }else{page.data.result='取色失败';}
        renderColor(page);
      }).catch(function(e){page.data.result='取色失败：'+e.message;renderColor(page);});
    }
    if(event.target.id==='saveColor'){
      if(!page.data.history)page.data.history=[];
      if(page.data.history[0]!==page.data.color){page.data.history.unshift(page.data.color);if(page.data.history.length>50)page.data.history.pop();}
      var his=$('colorHis');if(his)his.innerHTML=(page.data.history||[]).slice(0,30).map(function(c){return'<div class="cp-hist-row" data-color="'+c+'"><div class="cp-hist-swatch" style="background:'+c+'"></div><span class="cp-hist-hex">'+c.toUpperCase()+'</span></div>';}).join('');
    }
    if(event.target.id==='clearColorHistory'){page.data.history=[];var his2=$('colorHis');if(his2)his2.innerHTML='';}
    // JSPatch
    if(event.target.id==='runJSPatch'){runJSPatch(page);}
    if(event.target.id==='stopJSPatch'){
      if(_jsTimer){clearTimeout(_jsTimer);_jsTimer=null;}
      page.data.output=(page.data.output||'')+'\n⏹ 用户终止执行';
      var rb=$('runJSPatch'), sb=$('stopJSPatch');
      if(rb)rb.style.display=''; if(sb)sb.style.display='none';
      var out2=$('jspatchOut'); if(out2)out2.textContent=page.data.output;
    }
    if(event.target.id==='clearJSPatch'){page.data.output='';if($('jspatchOut'))$('jspatchOut').textContent='';page.data.missing=[];if($('jspatchMissing'))$('jspatchMissing').textContent='';}
    if(event.target.id==='detectJSPatch'){detectJSPatchGlobals(page);}
    if(event.target.id==='patchJSPatchGlobals'){
      if(page.data.missing&&page.data.missing.length){
        var reservedPatch={'static':1,'enum':1,'import':1,'export':1,'class':1,'function':1,'var':1,'let':1,'const':1,'return':1,'new':1,'delete':1,'void':1,'typeof':1,'yield':1,'await':1,'async':1,'default':1,'get':1,'set':1,'arguments':1};
        // 常见的 JS 方法/属性名，不可能是外部全局
        var commonMethods={'split':1,'slice':1,'join':1,'map':1,'filter':1,'reduce':1,'forEach':1,'find':1,'findIndex':1,'some':1,'every':1,'push':1,'pop':1,'shift':1,'unshift':1,'sort':1,'reverse':1,'concat':1,'includes':1,'indexOf':1,'flat':1,'flatMap':1,'keys':1,'values':1,'entries':1,'toString':1,'valueOf':1,'length':1,'name':1,'call':1,'apply':1,'bind':1,'has':1,'get':1,'set':1,'delete':1,'clear':1,'next':1,'done':1,'then':1,'catch':1,'finally':1,'resolve':1,'reject':1,'all':1,'race':1,'allSettled':1,'any':1,'abort':1,'signal':1};
        var lines=[];
        page.data.missing.forEach(function(m){
          var nm=m.split(':')[0].trim();
          if(reservedPatch[nm]||commonMethods[nm])return;
          lines.push('var '+nm+' = {};');
        });
        if(lines.length){
          var ta2=$('jspatchCode'); if(ta2){ta2.value='// 🔧 补环境声明\n'+lines.join('\n')+'\n\n'+ta2.value;syncJSHighlight();}
        }
      }
    }
    if(event.target.id==='beautifyJS'){_applyJSTransform(_jsBeautify);}
    if(event.target.id==='minifyJS'){_applyJSTransform(_jsMinify);}
    // Copy format card (supports bubbling from child elements)
    var cpTarget=event.target.closest('[data-cp]');
    if(cpTarget){copyText(cpTarget.dataset.cp);return;}
    // History dot click
    var colorHist=event.target.closest('[data-color]');
    if(colorHist){page.data.color=colorHist.dataset.color;renderColor(page);return;}
    // Window SPY
    if(event.target.id==='refreshWindows'){
      page.data._treeLoaded=false; page.data._treeLoading=true;
      page.data.result='重新枚举中...';renderWinSpy(page);
      invoke('spy_tree',{}).then(function(res){
        var data=parseMaybeJson(res);
        page.data.tree=data.items||[]; page.data._treeLoaded=true; page.data._treeLoading=false;
        page.data.result=(page.data.tree.length||0)+' 个窗口已枚举';
        renderWinSpy(page);
      }).catch(function(e){page.data._treeLoading=false; page.data.result='枚举失败：'+e.message;renderWinSpy(page);});
    }
    if(event.target.id==='spyWindow'){
      page.data.hwnd=$('spyHwnd').value;
      page.data.result='解析中...';renderWinSpy(page);
      invoke('spy_detail',{hwnd:page.data.hwnd}).then(function(res){
        page.data.detail=parseMaybeJson(res);
        page.data.result=page.data.detail.error?('解析失败：'+page.data.detail.error):'解析完成';
        renderWinSpy(page);
      }).catch(function(e){page.data.result='解析失败：'+e.message;renderWinSpy(page);});
    }
    // 窗口树 twist 展开/折叠
    var spyTwist=event.target.closest('[data-spy-twist]');
    if(spyTwist){
      event.stopPropagation();
      var parent=event.target.closest('.spy-node');
      if(parent){
        var children=parent.nextElementSibling;
        if(children&&children.classList.contains('spy-children')){
          var expand=children.style.display==='none';
          children.style.display=expand?'':'none';
          spyTwist.textContent=expand?'▼':'▶';
        }
      }
      return;
    }
    var spyTreeNode=event.target.closest('.spy-node');
    if(spyTreeNode){
      var prev=document.querySelector('.spy-node.active'); if(prev)prev.classList.remove('active');
      spyTreeNode.classList.add('active');
      page.data.hwnd=spyTreeNode.dataset.spyHwnd; $('spyHwnd').value=page.data.hwnd;
      page.data.result='解析中...';renderWinSpy(page);
      invoke('spy_detail',{hwnd:page.data.hwnd}).then(function(res){
        page.data.detail=parseMaybeJson(res);
        page.data.result=page.data.detail.error?('解析失败：'+page.data.detail.error):'解析完成';
        renderWinSpy(page);
      }).catch(function(e){page.data.result='解析失败：'+e.message;renderWinSpy(page);});
    }
    // Proxy
    if(event.target.id==='runProxyValidate'){
      page.data.input=$('proxyInput').value;page.data.maxDelayMs=Number($('proxyMaxDelay').value||3000);page.data.concurrency=Number($('proxyConcurrency').value||200);
      var lines=page.data.input.split(/\r?\n/).filter(function(x){return x.trim();});
      validateProxyList(page,lines).catch(function(e){page.data.result='验证失败：'+e.message;renderProxy(page);});
    }
    if(event.target.id==='runProxyApi'){syncProxy(page);page.data.result='API 提取验证中...';renderProxy(page);runProxyApi(page).catch(function(e){page.data.error=e.message;page.data.result='API失败：'+e.message;renderProxy(page);});}
    if(event.target.id==='toggleProxyTimer'){syncProxy(page);toggleProxyTimer(page);}
    if(event.target.id==='copyAliveProxy')copyText((page.data.alive||[]).map(function(p){return p.proxy||p.raw||'';}).join('\n'));
    if(event.target.id==='clearProxyResult'){page.data.result='';page.data.error='';page.data.alive=[];page.data.dead=[];renderProxy(page);}
    // Regex
    if(event.target.id==='runRegex'){
      page.data.pattern=$('regexPattern').value;page.data.flags=$('regexFlags').value;page.data.text=$('regexText').value;
      page.data.viewMode='match';
      try{
        var re=new RegExp(page.data.pattern,page.data.flags);var matches=[];var m;
        if(page.data.flags.indexOf('g')>=0){while((m=re.exec(page.data.text))){matches.push({index:m.index,match:m[0],groups:m.groups||null,captures:Array.from(m).slice(1)});}}
        else{m=re.exec(page.data.text);if(m)matches.push({index:m.index,match:m[0],groups:m.groups||null,captures:Array.from(m).slice(1)});}
        page.data.result=matches;page.data.regexError='';
      }catch(e){page.data.result=[];page.data.regexError=e.message;}
      renderRegex(page);
    }
    if(event.target.id==='runRegexReplace'){
      page.data.pattern=$('regexPattern').value;page.data.flags=$('regexFlags').value;page.data.text=$('regexText').value;
      page.data.replacement=$('regexReplacement')?$('regexReplacement').value:'';
      page.data.viewMode='replace';
      try{
        var re2=new RegExp(page.data.pattern,page.data.flags);
        page.data.replaced=page.data.text.replace(re2,page.data.replacement||'');
        page.data.regexError='';
      }catch(e){page.data.replaced='';page.data.regexError=e.message;}
      renderRegex(page);
    }
    if(event.target.dataset.regexView){page.data.viewMode=event.target.dataset.regexView;renderRegex(page);}
    if(event.target.id==='copyRegexResults')copyText(page.data.viewMode==='replace'?page.data.replaced:JSON.stringify(page.data.result,null,2));
    if(event.target.id==='copyRegexCode'){
      var rcl=document.querySelector('input[name="regexCodeLang"]:checked');rcl=rcl?rcl.value:'js';
      page.data.regexCodeLang=rcl;
      var pat=page.data.pattern||''; var flg=page.data.flags||''; var rep=page.data.replacement||'';
      var rc='';
      if(rcl==='js') rc='const re = /'+pat+'/'+flg+';\nconst result = str.match(re);\nconsole.log(result);';
      else if(rcl==='py') rc='import re\npattern = r\''+pat+'\'\nresult = re.findall(pattern, text)\nprint(result)';
      else if(rcl==='go') rc='package main\n\nimport (\n\t"fmt"\n\t"regexp"\n)\n\nfunc main() {\n\tre := regexp.MustCompile(`'+pat+'`)\n\tresult := re.FindAllString(text, -1)\n\tfmt.Println(result)\n}';
      else if(rcl==='rs') rc='use regex::Regex;\n\nfn main() {\n\tlet re = Regex::new("'+pat+'").unwrap();\n\tlet result: Vec<_> = re.find_iter(text).map(|m| m.as_str()).collect();\n\tprintln!("{:?}", result);\n}';
      else if(rcl==='cpp') rc='#include <regex>\n#include <string>\n\nstd::regex re("'+pat+'");\nstd::smatch m;\nstd::regex_search(str, m, re);';
      else if(rcl==='e') rc='.版本 2\n\n正则.创建 ('+pat+', )\n结果 ＝ 正则.搜索 (文本, )';
      var langNames={js:'JavaScript',py:'Python',go:'Go',rs:'Rust',cpp:'C++',e:tt('易语言')};
      showModal('<div class="modal-head"><div class="modal-title">'+tt('生成正则代码')+' ('+(langNames[rcl]||rcl)+')</div><button class="modal-close" id="closeModal">×</button></div><pre class="result-box" style="min-height:100px;max-height:50vh;padding:12px;background:rgba(0,0,0,0.3);border-radius:10px">'+esc(rc)+'</pre><button class="btn primary copy-code-btn" data-cp="'+esc(rc)+'" style="margin-top:10px;width:100%">📋 '+tt('复制到剪贴板')+'</button>');
    }
    if(event.target.id==='saveRegexSnippet'){var snips=JSON.parse(localStorage.getItem('regexSnippets')||'[]');snips.unshift({name:'Regex '+new Date().toLocaleTimeString(),pattern:page.data.pattern,flags:page.data.flags,replacement:page.data.replacement});localStorage.setItem('regexSnippets',JSON.stringify(snips.slice(0,30)));}
    if(event.target.id==='showRegexSnippets'){var sn=JSON.parse(localStorage.getItem('regexSnippets')||'[]');showModal('<div class="modal-head"><div class="modal-title">正则模板 ('+sn.length+')</div><button class="modal-close" id="closeModal">×</button></div><div class="info-list">'+(sn.length?sn.map(function(s,i){return'<div class="info-item"><span>'+esc(s.name)+'<br>'+esc(s.pattern)+'</span><strong><button class="btn small" data-use-snippet="'+i+'">使用</button></strong></div>';}).join(''):'<div class="tiny">暂无收藏</div>')+'</div>');}
    var useSnip=event.target.dataset.useSnippet;
    if(useSnip!==undefined){var sn2=JSON.parse(localStorage.getItem('regexSnippets')||'[]');var snp=sn2[Number(useSnip)];if(snp){page.data.pattern=snp.pattern;page.data.flags=snp.flags||'g';page.data.replacement=snp.replacement||'';closeModal();renderRegex(page);}}
    // Settings
    if(event.target.id==='saveSettings'){
      page.data.theme=$('settingTheme').value;page.data.fontSize=Number($('settingFont').value||13);page.data.startup=$('settingStartup').checked;
      state.theme=page.data.theme;localStorage.setItem('theme',state.theme);localStorage.setItem('fontSize',String(page.data.fontSize));localStorage.setItem('startup',page.data.startup?'1':'0');
      document.documentElement.style.setProperty('font-size',page.data.fontSize+'px','important');
      invoke('apply_theme',{theme:state.theme}).catch(function(){});
      render();
    }
    // Context menu
    if(event.target.dataset.action==='new-instance'){var cp=state.pages.find(function(p){return p.id===state.contextPageId;});if(cp)createPage(cp.type);}
    if(event.target.dataset.action==='duplicate'){var src=state.pages.find(function(p){return p.id===state.contextPageId;});if(src)createPage(src.type,src);}
    if(event.target.dataset.action==='close-instance')closePage(state.contextPageId);
    if(event.target.dataset.action==='close-others')closeOtherPages(state.contextPageId);
    if(event.target.dataset.action==='close-all-tabs')closeAllPages(state.contextPageId);
    if(event.target.dataset.action==='parse-http-json'){
      var httpPage=state.pages.find(function(p){return p.id===state.contextPageId;});
      if(httpPage&&httpPage.type==='http'){var text=httpPage.data.result||'';try{var wrapper=JSON.parse(text);if(typeof wrapper.body==='string')text=wrapper.body;}catch(e){}createJsonPageFromText('响应 JSON',text);}
    }

  });

  // Aiming reticle: mousedown triggers C++ targeting system
  document.addEventListener('mousedown', function(event){
    if(!event.target.closest('#pickMsaa') && !event.target.closest('#pickSpyWindow')) return;
    event.preventDefault();event.stopPropagation();
    var isMsaa=!!event.target.closest('#pickMsaa');
    var page=activePage();if(!page)return;
    page.data.result='🎯 瞄准镜已启动：拖动鼠标到目标窗口（红色边框闪烁），松开获取HWND。';
    if(isMsaa)renderMsaa(page);else renderWinSpy(page);
    invoke('pick_msaa_window',{}).then(function(res){
      var data=parseMaybeJson(res);
      if(!data.ok){page.data.result='拾取失败：'+(data.error||'timeout');if(isMsaa)renderMsaa(page);else renderWinSpy(page);return;}
      page.data.hwnd=data.hwnd||'';
      page.data.result='已获取 HWND：'+page.data.hwnd;
      if(isMsaa){
        invoke('inspect_msaa',{hwnd:page.data.hwnd}).then(function(d2){
          var detail=parseMaybeJson(d2);
          page.data.tree=detail.tree||null;page.data.selectedNode=page.data.tree;page.data.selectedPath='0';
          page.data.result=detail.tree?('MSAA 解析完成：'+(detail.nodeCount||0)+' 节点'+(detail.accessibleSource?('，来源 '+detail.accessibleSource):'')+(detail.truncated?'，已截断（上限 '+(detail.maxNodes||'')+'）':'')):'MSAA 解析完成 (无 MSAA 树)';
          renderMsaa(page);
        }).catch(function(e){page.data.tree=null;page.data.result='MSAA解析失败：'+e.message;renderMsaa(page);});
      } else {
        invoke('spy_detail',{hwnd:page.data.hwnd}).then(function(d2){
          var detail=parseMaybeJson(d2);
          page.data.detail=detail;page.data.result='SPY 解析完成';
          renderWinSpy(page);
        }).catch(function(e){page.data.result='SPY解析失败：'+e.message;renderWinSpy(page);});
      }
    }).catch(function(e){page.data.result='拾取失败：'+e.message;if(isMsaa)renderMsaa(page);else renderWinSpy(page);});
  });

  // Input sync
  document.addEventListener('input', function (event) {
    var page=activePage();if(!page)return;
    if(page.type==='http'&&(event.target.id==='httpMethod'||event.target.id==='httpProtocol'||event.target.id==='httpUrl'||event.target.id==='httpBody'||event.target.id==='httpHeaders'||event.target.id==='httpAutoDecode'||event.target.id==='httpNative'||event.target.dataset.kvKey||event.target.dataset.kvValue))syncHttp(page);
    if(page.type==='ws'&&(event.target.id==='wsUrl'||event.target.id==='wsMessage'||event.target.id==='wsAutoJson'||event.target.id==='wsReconnect'||event.target.id==='wsCookie'||event.target.id==='wsHeaders')){page.data.url=$('wsUrl')?$('wsUrl').value:page.data.url;page.data.message=$('wsMessage')?$('wsMessage').value:page.data.message;if($('wsCookie'))page.data.cookie=$('wsCookie').value;if($('wsHeaders'))page.data.headers=$('wsHeaders').value;}
    if(page.type==='encoding'&&(event.target.id==='encodingInput'||event.target.id==='encodingTarget')){page.data.input=$('encodingInput').value;page.data.target=$('encodingTarget').value;}
    if(page.type==='json'&&event.target.id==='jsonInput')page.data.input=$('jsonInput').value;
    if(page.type==='process'&&event.target.id==='procSearch'){page.data._procSearch=event.target.value;updateProcessStats(page);updateProcessTable(page,true);}
    if(page.type==='calculator'&&event.target.id==='calcExpression')page.data.expr=$('calcExpression').value;
    if(page.type==='calculator'&&event.target.id==='calcWord'){page.data.word=Number($('calcWord').value);renderCalculator(page);}
    if(page.type==='calculator'&&event.target.id==='calcBase')page.data.base=$('calcBase').value;
    if(page.type==='msaa'&&event.target.id==='msaaHwnd')page.data.hwnd=$('msaaHwnd').value;
    if(page.type==='color'&&(event.target.id==='colorNative2'||event.target.id==='colorNative'||event.target.id==='colorHexIn')){page.data.color=event.target.value||'#3b82f6';updateColorUI(page.data.color);}
    // Color slider + number input (sync without full re-render)
    if(page.type==='color'&&event.target.dataset.chan){
      var chan=event.target.dataset.chan;var type=event.target.dataset.type||(chan==='r'||chan==='g'||chan==='b'?'rgb':'hsl');
      var val=Number(event.target.value);if(isNaN(val))return;
      if(type==='hsl'){
        var oldHsl=rgbToHslObj(hexToRgb(page.data.color));
        if(chan==='h') page.data.color=hslToHex(val,oldHsl.s,oldHsl.l);
        else if(chan==='s') page.data.color=hslToHex(oldHsl.h,val,oldHsl.l);
        else if(chan==='l') page.data.color=hslToHex(oldHsl.h,oldHsl.s,val);
      } else {
        var oldRgb=hexToRgb(page.data.color);
        if(chan==='r') page.data.color=rgbToHex(val,oldRgb.g,oldRgb.b);
        else if(chan==='g') page.data.color=rgbToHex(oldRgb.r,val,oldRgb.b);
        else if(chan==='b') page.data.color=rgbToHex(oldRgb.r,oldRgb.g,val);
      }
      updateColorUI(page.data.color);
    }
    if(page.type==='winspy'&&event.target.id==='spyHwnd')page.data.hwnd=$('spyHwnd').value;
    if(page.type==='proxy'&&(event.target.id==='proxyInput'||event.target.id==='proxyMaxDelay'||event.target.id==='proxyConcurrency'||event.target.id==='proxyApiUrl'||event.target.id==='proxyApiFormat'||event.target.id==='proxyIntervalSec')){syncProxy(page);}
    if(page.type==='regex'&&(event.target.id==='regexPattern'||event.target.id==='regexFlags'||event.target.id==='regexText')){if($('regexPattern'))page.data.pattern=$('regexPattern').value;if($('regexFlags'))page.data.flags=$('regexFlags').value;if($('regexText'))page.data.text=$('regexText').value;}
    if(page.type==='settings'&&event.target.id==='settingTheme')page.data.theme=$('settingTheme').value;
    if(page.type==='settings'&&event.target.id==='settingFont')page.data.fontSize=Number($('settingFont').value||13);
    if(page.type==='settings'&&event.target.id==='settingStartup')page.data.startup=$('settingStartup').checked;
  });

  // Context menu
  document.addEventListener('contextmenu', function (event) {
    // 窗口树区域右键刷新
    if(event.target.closest('#spyComponentTree')||event.target.closest('.spy-right')){
      event.preventDefault();
      var btn=$('refreshWindows');
      if(btn){btn.click();}else{
        var page=activePage(); if(page&&page.type==='winspy'){
          page.data._treeLoaded=false; page.data._treeLoading=true;
          page.data.result='重新枚举中...'; renderWinSpy(page);
          invoke('spy_tree',{}).then(function(res){
            var data=parseMaybeJson(res);
            page.data.tree=data.items||[]; page.data._treeLoaded=true; page.data._treeLoading=false;
            page.data.result=(page.data.tree.length||0)+' 个窗口已枚举';
            renderWinSpy(page);
          }).catch(function(e){page.data._treeLoading=false; renderWinSpy(page);});
        }
      }
      return;
    }
    var tool=event.target.closest('.tool-item');
    var tab=event.target.closest('.tab');
    var httpResult=event.target.closest('#httpResult');
    var procRow=event.target.closest('.proc-row');
    $('contextMenu').classList.remove('show');
    $('procContextMenu').classList.remove('show');
    if(procRow){
      event.preventDefault();
      procRow.classList.add('selected');
      var menu=$('procContextMenu');
      menu.style.left=event.clientX+'px';menu.style.top=event.clientY+'px';menu.classList.add('show');
      return;
    }
    if(!tool&&!tab&&!httpResult)return;
    event.preventDefault();
    var page=httpResult?activePage():(tab?state.pages.find(function(p){return p.id===tab.dataset.id;}):state.pages.find(function(p){return p.type===tool.dataset.type;}));
    if(!page&&tool){createPage(tool.dataset.type);page=activePage();}
    state.contextPageId=page.id;
    state.contextKind=httpResult?'http-result':'page';
    $('parseHttpJsonAction').style.display=state.contextKind==='http-result'&&page.type==='http'?'':'none';
    var hideTabBulk=!tab;
    var closeOthers=$('closeOthersAction'), closeAll=$('closeAllTabsAction');
    if(closeOthers)closeOthers.style.display=hideTabBulk?'none':'';
    if(closeAll)closeAll.style.display=hideTabBulk?'none':'';
    var sep=document.querySelector('#contextMenu .cmenu-sep');
    if(sep)sep.style.display=hideTabBulk?'none':'';
    var menu=$('contextMenu');
    menu.style.left=event.clientX+'px';menu.style.top=event.clientY+'px';menu.classList.add('show');
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', function (event) {
    var page=activePage();if(!page)return;
    // Ctrl+Enter: Send HTTP request
    if(event.ctrlKey&&event.key==='Enter'&&page.type==='http'){event.preventDefault();sendHttp(page);return;}
    // Ctrl+W: Close current tab
    if(event.ctrlKey&&event.key==='w'){event.preventDefault();closePage(page.id);return;}
    // Ctrl+T: New same-type page
    if(event.ctrlKey&&event.key==='t'){event.preventDefault();createPage(page.type);return;}
    // Ctrl+1~Ctrl+0: Switch to tab index
    if(event.ctrlKey&&event.key>='0'&&event.key<='9'){
      event.preventDefault();
      var idx=event.key==='0'?9:Number(event.key)-1;
      if(state.pages[idx]){state.activeId=state.pages[idx].id;render();}
      return;
    }
    // Tab switching: Ctrl+Tab / Ctrl+Shift+Tab
    if(event.ctrlKey&&event.key==='Tab'){
      event.preventDefault();
      var curIdx=state.pages.findIndex(function(p){return p.id===state.activeId;});
      var next=event.shiftKey?Math.max(0,curIdx-1):Math.min(state.pages.length-1,curIdx+1);
      if(state.pages[next]){state.activeId=state.pages[next].id;render();}
      return;
    }
    // Enter on calculator expression field
    if(event.key==='Enter'&&page.type==='calculator'&&event.target.id==='calcExpression')runCalc(page);
    // Ctrl+R: Refresh (process/SPY)
    if(event.ctrlKey&&event.key==='r'&&(page.type==='process'||page.type==='winspy')){
      event.preventDefault();
      if(page.type==='process')$('refreshProcess')&&$('refreshProcess').click();
      if(page.type==='winspy')$('refreshWindows')&&$('refreshWindows').click();
    }
    // F12 开发者工具（仅开发模式生效，发布模式 C++ 会拒绝）
    if(event.key==='F12'){event.preventDefault();invoke('toggle_devtools',{}).catch(function(){});return;}
    // F5 开发模式刷新（发布模式被 preload JS 拦截）
    if(event.key==='F5'&&page){event.preventDefault();render();return;}
  });

  // ═══════════ PURE JS CRYPTO ═══════════
  function bytesToHex(bytes){return Array.from(bytes).map(function(b){return b.toString(16).padStart(2,'0');}).join('');}
  function utf8Bytes(text){return new TextEncoder().encode(text);}
  function bytesToBase64(bytes){var s='';bytes.forEach(function(b){s+=String.fromCharCode(b);});return btoa(s);}
  function base64ToText(text){return new TextDecoder().decode(Uint8Array.from(atob(text),function(c){return c.charCodeAt(0);}));}
  function hexToBytes(text){var clean=String(text||'').replace(/[^0-9a-fA-F]/g,'');if(clean.length%2)clean='0'+clean;var bytes=[];for(var i=0;i<clean.length;i+=2)bytes.push(parseInt(clean.slice(i,i+2),16));return bytes;}
  function hexToText(text){return new TextDecoder().decode(new Uint8Array(hexToBytes(text)));}
  function hexPrintableText(bytes){
    if(!bytes.length)return '';
    var decoded=new TextDecoder('utf-8',{fatal:false}).decode(new Uint8Array(bytes));
    var visible=decoded.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,'·');
    return visible;
  }
  function hexDecodeDetail(text){
    var bytes=hexToBytes(text);
    if(!bytes.length)return 'HEX 输入为空或没有可解析字节。';
    var hex=bytes.map(function(b){return b.toString(16).padStart(2,'0').toUpperCase();}).join(' ');
    var preview=hexPrintableText(bytes);
    return 'UTF-8 预览：'+preview+'\n十六进制字节：'+hex;
  }
  function hexDecodePreview(text){
    var bytes=hexToBytes(text);
    if(!bytes.length)return '(empty)';
    var preview=hexPrintableText(bytes).replace(/[\r\n]+/g,' ');
    var hex=bytes.slice(0,16).map(function(b){return b.toString(16).padStart(2,'0').toUpperCase();}).join(' ');
    return preview+' | HEX '+hex+(bytes.length>16?' ...':'');
  }
  function digest(algorithm,text){return invoke('hash_text',{algorithm:algorithm,text:text}).then(function(res){var data=parseMaybeJson(res);if(typeof data==='string')return data;if(!data||data.ok===false)throw new Error((data&&data.error)||'hash failed');return data.hash||data.result||'';});}
  function md5(text){
    function add(x,y){return(x+y)|0;}function rol(x,c){return(x<<c)|(x>>>(32-c));}
    function cmn(q,a,b,x,s,t){return add(rol(add(add(a,q),add(x,t)),s),b);}
    function ff(a,b,c,d,x,s,t){return cmn((b&c)|(~b&d),a,b,x,s,t);}
    function gg(a,b,c,d,x,s,t){return cmn((b&d)|(c&~d),a,b,x,s,t);}
    function hh(a,b,c,d,x,s,t){return cmn(b^c^d,a,b,x,s,t);}
    function ii(a,b,c,d,x,s,t){return cmn(c^(b|~d),a,b,x,s,t);}
    var bytes=Array.from(utf8Bytes(text));var bitLen=bytes.length*8;bytes.push(0x80);while(bytes.length%64!==56)bytes.push(0);for(var bl=bitLen;bytes.length%64!==0||bl>0;){bytes.push(bl&255);bl=Math.floor(bl/256);if(bytes.length%64===0&&bl===0)break;}
    var a=1732584193,b=-271733879,c=-1732584194,d=271733878;
    for(var i=0;i<bytes.length;i+=64){var x=[];for(var j=0;j<16;j++)x[j]=bytes[i+j*4]|(bytes[i+j*4+1]<<8)|(bytes[i+j*4+2]<<16)|(bytes[i+j*4+3]<<24);var oa=a,ob=b,oc=c,od=d;
      a=ff(a,b,c,d,x[0],7,-680876936);d=ff(d,a,b,c,x[1],12,-389564586);c=ff(c,d,a,b,x[2],17,606105819);b=ff(b,c,d,a,x[3],22,-1044525330);
      a=ff(a,b,c,d,x[4],7,-176418897);d=ff(d,a,b,c,x[5],12,1200080426);c=ff(c,d,a,b,x[6],17,-1473231341);b=ff(b,c,d,a,x[7],22,-45705983);
      a=ff(a,b,c,d,x[8],7,1770035416);d=ff(d,a,b,c,x[9],12,-1958414417);c=ff(c,d,a,b,x[10],17,-42063);b=ff(b,c,d,a,x[11],22,-1990404162);
      a=ff(a,b,c,d,x[12],7,1804603682);d=ff(d,a,b,c,x[13],12,-40341101);c=ff(c,d,a,b,x[14],17,-1502002290);b=ff(b,c,d,a,x[15],22,1236535329);
      a=gg(a,b,c,d,x[1],5,-165796510);d=gg(d,a,b,c,x[6],9,-1069501632);c=gg(c,d,a,b,x[11],14,643717713);b=gg(b,c,d,a,x[0],20,-373897302);
      a=gg(a,b,c,d,x[5],5,-701558691);d=gg(d,a,b,c,x[10],9,38016083);c=gg(c,d,a,b,x[15],14,-660478335);b=gg(b,c,d,a,x[4],20,-405537848);
      a=gg(a,b,c,d,x[9],5,568446438);d=gg(d,a,b,c,x[14],9,-1019803690);c=gg(c,d,a,b,x[3],14,-187363961);b=gg(b,c,d,a,x[8],20,1163531501);
      a=gg(a,b,c,d,x[13],5,-1444681467);d=gg(d,a,b,c,x[2],9,-51403784);c=gg(c,d,a,b,x[7],14,1735328473);b=gg(b,c,d,a,x[12],20,-1926607734);
      a=hh(a,b,c,d,x[5],4,-378558);d=hh(d,a,b,c,x[8],11,-2022574463);c=hh(c,d,a,b,x[11],16,1839030562);b=hh(b,c,d,a,x[14],23,-35309556);
      a=hh(a,b,c,d,x[1],4,-1530992060);d=hh(d,a,b,c,x[4],11,1272893353);c=hh(c,d,a,b,x[7],16,-155497632);b=hh(b,c,d,a,x[10],23,-1094730640);
      a=hh(a,b,c,d,x[13],4,681279174);d=hh(d,a,b,c,x[0],11,-358537222);c=hh(c,d,a,b,x[3],16,-722521979);b=hh(b,c,d,a,x[6],23,76029189);
      a=hh(a,b,c,d,x[9],4,-640364487);d=hh(d,a,b,c,x[12],11,-421815835);c=hh(c,d,a,b,x[15],16,530742520);b=hh(b,c,d,a,x[2],23,-995338651);
      a=ii(a,b,c,d,x[0],6,-198630844);d=ii(d,a,b,c,x[7],10,1126891415);c=ii(c,d,a,b,x[14],15,-1416354905);b=ii(b,c,d,a,x[5],21,-57434055);
      a=ii(a,b,c,d,x[12],6,1700485571);d=ii(d,a,b,c,x[3],10,-1894986606);c=ii(c,d,a,b,x[10],15,-1051523);b=ii(b,c,d,a,x[1],21,-2054922799);
      a=ii(a,b,c,d,x[8],6,1873313359);d=ii(d,a,b,c,x[15],10,-30611744);c=ii(c,d,a,b,x[6],15,-1560198380);b=ii(b,c,d,a,x[13],21,1309151649);
      a=ii(a,b,c,d,x[4],6,-145523070);d=ii(d,a,b,c,x[11],10,-1120210379);c=ii(c,d,a,b,x[2],15,718787259);b=ii(b,c,d,a,x[9],21,-343485551);
      a=add(a,oa);b=add(b,ob);c=add(c,oc);d=add(d,od);}
    return[a,b,c,d].map(function(n){return[0,8,16,24].map(function(s){return((n>>>s)&255).toString(16).padStart(2,'0');}).join('');}).join('');
  }
  function sha256Pure(text){
    function rotr(n,x){return(x>>>n)|(x<<(32-n));}function add(){var sum=0;for(var i=0;i<arguments.length;i++)sum=(sum+arguments[i])>>>0;return sum;}
    var k=[1116352408,1899447441,3049323471,3921009573,961987163,1508970993,2453635748,2870763221,3624381080,310598401,607225278,1426881987,1925078388,2162078206,2614888103,3248222580,3835390401,4022224774,264347078,604807628,770255983,1249150122,1555081692,1996064986,2554220882,2821834349,2952996808,3210313671,3336571891,3584528711,113926993,338241895,666307205,773529912,1294757372,1396182291,1695183700,1986661051,2177026350,2456956037,2730485921,2820302411,3259730800,3345764771,3516065817,3600352804,4094571909,275423344,430227734,506948616,659060556,883997877,958139571,1322822218,1537002063,1747873779,1955562222,2024104815,2227730452,2361852424,2428436474,2756734187,3204031479,3329325298];
    var h=[1779033703,3144134277,1013904242,2773480762,1359893119,2600822924,528734635,1541459225];
    var bytes=Array.from(utf8Bytes(text));var bitLen=bytes.length*8;bytes.push(0x80);while((bytes.length%64)!==56)bytes.push(0);
    for(var len=bitLen;len>0xFFFFFFFF;len=Math.floor(len/0x100000000))bytes.push(0);bytes.push(0,0,0,0,(bitLen>>>24)&255,(bitLen>>>16)&255,(bitLen>>>8)&255,bitLen&255);
    for(var i=0;i<bytes.length;i+=64){
      var w=new Array(64);for(var j=0;j<16;j++)w[j]=((bytes[i+j*4]<<24)|(bytes[i+j*4+1]<<16)|(bytes[i+j*4+2]<<8)|bytes[i+j*4+3])>>>0;
      for(j=16;j<64;j++){var s0=rotr(7,w[j-15])^rotr(18,w[j-15])^(w[j-15]>>>3);var s1=rotr(17,w[j-2])^rotr(19,w[j-2])^(w[j-2]>>>10);w[j]=add(w[j-16],s0,w[j-7],s1);}
      var a=h[0],b=h[1],c=h[2],dd=h[3],e=h[4],f=h[5],g=h[6],hh=h[7];
      for(j=0;j<64;j++){var S1=rotr(6,e)^rotr(11,e)^rotr(25,e);var ch=(e&f)^(~e&g);var temp1=add(hh,S1,ch,k[j],w[j]);var S0=rotr(2,a)^rotr(13,a)^rotr(22,a);var maj=(a&b)^(a&c)^(b&c);var temp2=add(S0,maj);hh=g;g=f;f=e;e=add(dd,temp1);dd=c;c=b;b=a;a=add(temp1,temp2);}
      h=[add(h[0],a),add(h[1],b),add(h[2],c),add(h[3],dd),add(h[4],e),add(h[5],f),add(h[6],g),add(h[7],hh)];
    }
    return h.map(function(x){return x.toString(16).padStart(8,'0');}).join('');
  }

  // USC2(\uXXXX 转义) → ANSI/中文：把 目前 这类转义还原成可读文本
  function unicodeDecode(text){
    return String(text)
      .replace(/\\u\{([0-9a-fA-F]+)\}/g,function(m,h){try{return String.fromCodePoint(parseInt(h,16));}catch(e){return m;}})
      .replace(/\\u([0-9a-fA-F]{4})/g,function(m,h){return String.fromCharCode(parseInt(h,16));});
  }
  // ANSI/中文 → USC2(\uXXXX)：非 ASCII 字符转成 \uXXXX，ASCII 原样保留
  function unicodeEncode(text){
    var o='';
    text=String(text);
    for(var i=0;i<text.length;i++){
      var c=text.charCodeAt(i);
      o += c>0x7f ? '\\u'+('0000'+c.toString(16)).slice(-4) : text.charAt(i);
    }
    return o;
  }

  function convertText(text,target){
    if(target==='unicode-decode')return Promise.resolve(unicodeDecode(text));
    if(target==='unicode-encode')return Promise.resolve(unicodeEncode(text));
    if(target==='base64-encode')return Promise.resolve(bytesToBase64(utf8Bytes(text)));
    if(target==='base64-decode')return Promise.resolve(base64ToText(text));
    if(target==='url-encode')return Promise.resolve(encodeURIComponent(text));
    if(target==='url-decode')return Promise.resolve(decodeURIComponent(text));
    if(target==='hex-encode')return Promise.resolve(bytesToHex(utf8Bytes(text)));
    if(target==='hex-decode')return Promise.resolve(hexToText(text));
    if(target==='md5')return Promise.resolve(md5(text));
    if(target==='sha1')return digest('SHA-1',text);
    if(target==='sha256')return Promise.resolve(sha256Pure(text));
    if(target==='sha384')return digest('SHA-384',text);
    if(target==='sha512')return digest('SHA-512',text);
    if(target==='lower')return Promise.resolve(text.toLowerCase());
    if(target==='upper')return Promise.resolve(text.toUpperCase());
    return Promise.reject(new Error('unsupported transform'));
  }

  
  $('activeSubtitle').textContent=JADE.d('JPJ:eJa:JnJu:JtJ J:SJoJfJt:J J·J JQJQ:J J2J4J5J8J6J7');
  createPage('http');
  state.activeId=state.pages[0].id;
  document.documentElement.style.setProperty('font-size', (localStorage.getItem('fontSize')||13)+'px', 'important');
  document.documentElement.style.setProperty('font-family', '"'+ (localStorage.getItem('fontFamily')||'Microsoft YaHei UI') +'","Microsoft YaHei UI","Segoe UI",Arial,sans-serif', 'important');
  function initContextMenus(){
    if($('parseHttpJsonAction'))$('parseHttpJsonAction').textContent=tt('解析 HTTP 响应 JSON 到新页');
    if($('closeOthersAction'))$('closeOthersAction').textContent=tt('关闭其他标签');
    if($('closeAllTabsAction'))$('closeAllTabsAction').textContent=tt('关闭全部标签');
  }
  initContextMenus();
  // 最大化检测：窗口尺寸≈屏幕工作区时给 body 加 .maximized(原生此时也去圆角)，
  // 让 .app 同步去圆角，避免最大化四角缺口。对按钮/双击/Win+↑ 都生效。
  function syncMaximizedClass(){
    try{
      var maxed = window.innerWidth >= screen.availWidth - 4 && window.innerHeight >= screen.availHeight - 4;
      document.body.classList.toggle('maximized', maxed);
    }catch(e){}
  }
  window.addEventListener('resize', syncMaximizedClass);
  syncMaximizedClass();
  render();
  if(!INTERNAL_TESTS_ENABLED){var btn=$('runInternalTests');if(btn)btn.style.display='none';}
  else if(INTERNAL_TESTS_AUTORUN){setTimeout(runInternalTests,1200);}

  // 双击复制 spy-detail-row / detail-row 内容
  document.addEventListener('dblclick',function(event){
    // cp-hist-row 双击复制 HEX
    var chRow=event.target.closest('.cp-hist-row');
    if(chRow){copyText(chRow.dataset.color);return;}
    var row=event.target.closest('.spy-detail-row,.detail-row');
    if(!row)return;
    var strong=row.querySelector('strong');
    var text=strong?strong.textContent:row.textContent;
    if(text)copyText(text.trim());
  });
})();
