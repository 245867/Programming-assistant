// ═══════════════ WebSocket Tool ═══════════════
// ═══════════════════════ WEBSOCKET FIXED ═══════════════════════
  function renderWs(page) { var d=page.data;
    $('page').innerHTML='<div class="tool-page">'+renderHero(page,
      '<span class="ws-state '+(d.state==='open'?'ok':d.state==='error'||d.state==='closed'?'bad':'')+'">'+esc(d.state)+'</span>'+
      '<button class="btn primary" id="connectWs">'+tt('连接')+'</button><button class="btn" id="closeWs">'+tt('关闭')+'</button>'+
      '<button class="btn" id="pingWs">Ping</button>'+
      '<button class="btn" id="clearWsLog">'+tt('清空')+'</button><button class="btn" id="copyWsLog">'+tt('复制日志')+'</button>')+
      '<div class="grid"><div class="panel-card span-5">'+
      '<input id="wsUrl" placeholder="wss:// 或 ws:// 地址" value="'+esc(d.url)+'">'+
      '<div style="display:flex;gap:18px;align-items:center;margin:6px 0">'+
        '<label style="margin:0;display:inline-flex;align-items:center;gap:4px"><input type="checkbox" id="wsAutoJson" '+(d.autoJson?'checked':'')+'> '+tt('发送前压缩 JSON')+'</label>'+
        '<label style="margin:0;display:inline-flex;align-items:center;gap:4px"><input type="checkbox" id="wsReconnect" '+(d.reconnect?'checked':'')+'> '+tt('断线自动重连')+'</label>'+
      '</div>'+
      '<label>Cookie '+tt('（填写则走原生，wss 可携带 cookie）')+'</label><input id="wsCookie" class="mono" placeholder="name=value; name2=value2" value="'+esc(d.cookie||'')+'">'+
      '<label>'+tt('附加请求头（每行 Key: Value，可选）')+'</label><textarea id="wsHeaders" class="mono" style="min-height:254px" placeholder="Origin: https://example.com\nAuthorization: Bearer xxx">'+esc(d.headers||'')+'</textarea>'+
      '<label>Message</label><textarea id="wsMessage" class="mono" style="min-height:90px">'+esc(d.message)+'</textarea>'+
      '<button class="btn primary" id="sendWs2" style="margin-top:8px;width:100%;min-height:47px">'+tt('发送消息')+'</button>'+
      '</div><div class="panel-card span-7"><div class="panel-title">Session Log</div>'+
      '<pre class="result-box" id="wsLog">'+esc(d.log||'未连接')+'</pre></div></div></div>';
  }
