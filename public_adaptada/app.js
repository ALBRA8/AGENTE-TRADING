document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');
  const chatMessages = document.getElementById('chat-messages');
  const modal = document.getElementById('reasoning-modal');
  const modalBody = document.getElementById('reasoning-body');
  const closeModalBtn = document.getElementById('close-reasoning');

  // Load history on start
  fetchHistory();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;

    // Add user message
    addMessage(text, 'user');
    input.value = '';

    // Show typing indicator
    const typingId = addTypingIndicator();

    try {
      const resp = await fetch('/api/chat/message', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ message: text })
      });

      const data = await resp.json();
      removeElement(typingId);

      if (data.error) {
        addMessage(`❌ Error: ${data.error}`, 'ai');
        return;
      }

      addMessage(data.response, 'ai', data.reasoning);
      
    } catch (err) {
      removeElement(typingId);
      addMessage(`❌ System Error: ${err.message}`, 'ai');
    }
  });

  closeModalBtn.addEventListener('click', () => {
    modal.classList.remove('active');
  });

  async function fetchHistory() {
    try {
      const resp = await fetch('/api/chat/history');
      const messages = await resp.json();
      
      // Clear current UI except system greeting
      const systemGreeting = chatMessages.innerHTML;
      chatMessages.innerHTML = '';
      
      messages.forEach(m => {
        if (m.role === 'user' || m.role === 'assistant') {
          // We don't have reasoning stored in history currently, so passing null
          addMessage(m.content, m.role === 'assistant' ? 'ai' : 'user', null, false);
        }
      });

      if (chatMessages.children.length === 0) {
        chatMessages.innerHTML = systemGreeting;
      }
      scrollToBottom();
    } catch(err) {
      console.error("Failed to load history", err);
    }
  }

  function addMessage(text, type, reasoning = null, animate = true) {
    const div = document.createElement('div');
    div.classList.add('message', type);
    if (!animate) {
      div.style.animation = 'none';
      div.style.opacity = '1';
      div.style.transform = 'translateY(0)';
    }

    // Parse markdown
    const htmlContent = marked.parse(text);
    div.innerHTML = htmlContent;

    if (reasoning) {
      const rBtn = document.createElement('button');
      rBtn.classList.add('reasoning-btn');
      rBtn.innerText = '🧠 View Nemotron Reasoning';
      rBtn.onclick = () => {
        modalBody.innerHTML = marked.parse(reasoning);
        modal.classList.add('active');
      };
      div.appendChild(rBtn);
    }

    chatMessages.appendChild(div);
    scrollToBottom();
  }

  function addTypingIndicator() {
    const id = 'typing-' + Date.now();
    const div = document.createElement('div');
    div.id = id;
    div.classList.add('typing-indicator');
    div.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';
    chatMessages.appendChild(div);
    scrollToBottom();
    return id;
  }

  function removeElement(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
  }

  function scrollToBottom() {
    const wrapper = document.querySelector('.chat-wrapper');
    wrapper.scrollTop = wrapper.scrollHeight;
  }

  // ── Vista Cerebro (observabilidad + evaluación) ──────────────
  const chatWrapper = document.getElementById('chat-wrapper');
  const brainView = document.getElementById('brain-view');
  const trackRecordView = document.getElementById('trackrecord-view');
  const inputArea = document.getElementById('input-area');
  const viewTitle = document.getElementById('view-title');
  const viewSubtitle = document.getElementById('view-subtitle');
  const modeBadge = document.getElementById('mode-badge');
  let brainLoaded = false;
  let trackRecordLoaded = false;

  // ── Badge de modo [DEMO]/[LIVE] (Task 8-b) ──
  function setModeBadge(mode) {
    if (!modeBadge || !mode) return;
    const m = String(mode).toUpperCase() === 'LIVE' ? 'LIVE' : 'DEMO';
    modeBadge.textContent = m;
    modeBadge.classList.toggle('live', m === 'LIVE');
    modeBadge.classList.toggle('demo', m !== 'LIVE');
    modeBadge.title = m === 'LIVE'
      ? 'Modo LIVE: las órdenes se ejecutan en tu cuenta MT5 real'
      : 'Modo operativo: DEMO no ejecuta órdenes reales';
  }

  // Prioridad: window.TRADING_MODE (inyectado) → /api/agent/status (campo mode)
  if (window.TRADING_MODE) {
    setModeBadge(window.TRADING_MODE);
  } else {
    fetch('/api/agent/status').then((r) => r.json())
      .then((s) => setModeBadge(s.mode))
      .catch(() => { /* badge queda en DEMO por defecto */ });
  }

  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
      item.classList.add('active');
      const view = item.dataset.view;
      if (view === 'brain') {
        chatWrapper.hidden = true;
        trackRecordView.hidden = true;
        brainView.hidden = false;
        inputArea.style.display = 'none';
        viewTitle.firstChild.textContent = 'Centro de Mando del Agente';
        viewSubtitle.textContent = 'Observabilidad en vivo · Pipeline SOP v3.1 · Auto-mejora';
        if (!brainLoaded) loadBrainView().catch(console.error);
      } else if (view === 'trackrecord') {
        chatWrapper.hidden = true;
        brainView.hidden = true;
        trackRecordView.hidden = false;
        inputArea.style.display = 'none';
        viewTitle.firstChild.textContent = 'Track Record ';
        viewSubtitle.textContent = 'Historial auditado · "el único bot que te demuestra por qué NO operó" · no es una promesa de rentabilidad';
        if (!trackRecordLoaded) loadTrackRecordView().catch(console.error);
      } else {
        brainView.hidden = true;
        trackRecordView.hidden = true;
        chatWrapper.hidden = false;
        inputArea.style.display = '';
        viewTitle.firstChild.textContent = 'Analista Senior SMC';
        viewSubtitle.textContent = 'Bridge MT5 local (bridge.py) | NVIDIA NIM: nemotron-3-super-120b-a12b + llama-3.3-70b-instruct';
      }
    });
  });

  async function loadBrainView() {
    const [statusResp, brainResp] = await Promise.all([
      fetch('/api/agent/status').then((r) => r.json()),
      fetch('/api/agent/brain').then((r) => r.json()),
    ]);
    brainLoaded = true;

    // Score grande + veredicto
    const scoreEl = document.getElementById('brain-score');
    scoreEl.textContent = brainResp.score.toFixed(1);
    scoreEl.classList.remove('good', 'mid', 'bad');
    scoreEl.classList.add(brainResp.score >= 80 ? 'good' : brainResp.score >= 60 ? 'mid' : 'bad');
    document.getElementById('brain-verdict').textContent = brainResp.verdict;

    // Tendencia (mini barras)
    const trend = brainResp.trend || [];
    document.getElementById('brain-trend').innerHTML = trend.length
      ? trend.map((t) => `<span class="trend-bar" style="height:${Math.max(8, (t.score / 100) * 48)}px" title="${t.score.toFixed(1)}"></span>`).join('')
      : '<span class="muted">Sin snapshots aún</span>';

    // Componentes con barras de progreso
    const compLabels = {
      discipline: '🛡️ Disciplina',
      calibration: '🎯 Calibración',
      followThrough: '📌 Seguimiento',
      learning: '🧬 Aprendizaje',
      operational: '⚙️ Operativa',
    };
    document.getElementById('brain-components').innerHTML = Object.entries(brainResp.components).map(([key, c]) => {
      const pct = Math.round((c.score / c.max) * 100);
      const color = pct >= 80 ? '#2dd4a7' : pct >= 55 ? '#f5b942' : '#e05c5c';
      return `<div class="comp-row">
        <div class="comp-head"><span>${compLabels[key] || key}</span><span class="comp-pts">${c.score}/${c.max}</span></div>
        <div class="comp-bar"><div class="comp-fill" style="width:${pct}%;background:${color}"></div></div>
        <div class="comp-detail">${c.detail}</div>
      </div>`;
    }).join('');

    // Estado operativo 24h
    const s = statusResp;
    const a = s.decisions.last24hByAction;
    const wr = s.performance.winRate === null ? '—' : (s.performance.winRate * 100).toFixed(0) + '%';
    document.getElementById('agent-status-cards').innerHTML = `
      <div class="stat-row"><span>Decisiones 24h · 7d</span><b>${s.decisions.last24h} · ${s.decisions.last7d}</b></div>
      <div class="stat-row"><span>🚀 EXECUTE / ⏳ WAIT / 🔍 REVIEW / 🛑 ABORTED (24h)</span><b>${a.EXECUTE} / ${a.WAIT} / ${a.REVIEW} / ${a.ABORTED}</b></div>
      <div class="stat-row"><span>Tokens 24h</span><b>${s.performance.tokens24h.toLocaleString()}</b></div>
      <div class="stat-row"><span>Latencia media pipeline</span><b>${(s.performance.avgLatencyMs24h / 1000).toFixed(1)}s</b></div>
      <div class="stat-row"><span>Settlement pendiente</span><b>${s.decisions.pendingSettlement}</b></div>
      <div class="stat-row"><span>PnL settled · Win rate</span><b class="${s.performance.totalPnl >= 0 ? 'pos' : 'neg'}">${s.performance.totalPnl >= 0 ? '+' : ''}${s.performance.totalPnl} USD · ${wr}</b></div>`;

    // Seguridad + auto-mejora
    document.getElementById('agent-safety').innerHTML = `
      <div class="stat-row"><span>Hard-gate de ejecución</span><b>${s.safety.pipelineGate ? '🟢 ON' : '🔴 OFF'}</b></div>
      <div class="stat-row"><span>Riesgo máximo por trade</span><b>${s.safety.maxRiskPct}%</b></div>
      <div class="stat-row"><span>Horizonte de settlement</span><b>${s.safety.settlementHorizonHours}h</b></div>
      <div class="stat-row"><span>Lecciones aprendidas</span><b>${s.selfImprove.lessonsTotal} (${s.selfImprove.lessonsVerified} ✓ · ${s.selfImprove.lessonsPromoted} ⭐)</b></div>
      <div class="stat-row"><span>Errores sin resolver</span><b>${s.selfImprove.unresolvedErrorPatterns}</b></div>
      <div class="stat-row"><span>Último settlement</span><b>${s.selfImprove.lastSettlementAt ? new Date(s.selfImprove.lastSettlementAt).toLocaleString() : '—'}</b></div>
      <div class="stat-row"><span>Bridge MT5</span><b>${s.dependencies.mt5Bridge ? '🟢' : '🔴'} (demo)</b></div>
      <div class="stat-row"><span>Modelo quick · deep</span><b class="models-cell">${s.safety.models.quick.split('/').pop()} · ${s.safety.models.deep.split('/').pop()}</b></div>`;

    // Números del escritorio
    const st = brainResp.stats;
    document.getElementById('brain-stats').innerHTML = `
      <div class="stats-grid">
        <div><span>Decisiones totales</span><b>${st.totalDecisions}</b></div>
        <div><span>EXECUTE</span><b>${st.byAction.EXECUTE ?? 0}</b></div>
        <div><span>WAIT</span><b>${st.byAction.WAIT ?? 0}</b></div>
        <div><span>REVIEW</span><b>${st.byAction.REVIEW ?? 0}</b></div>
        <div><span>ABORTED</span><b>${st.byAction.ABORTED ?? 0}</b></div>
        <div><span>Settled (W/L)</span><b>${st.settled} (${st.wins}/${st.losses})</b></div>
        <div><span>Win rate</span><b>${st.winRate === null ? '—' : (st.winRate * 100).toFixed(0) + '%'}</b></div>
        <div><span>PnL acumulado</span><b class="${st.totalPnl >= 0 ? 'pos' : 'neg'}">${st.totalPnl >= 0 ? '+' : ''}${st.totalPnl} USD</b></div>
        <div><span>Tokens por decisión</span><b>≈${st.tokens.avgPerDecision.toLocaleString()}</b></div>
        <div><span>Latencia media</span><b>${(st.latency.avgMs / 1000).toFixed(1)}s</b></div>
      </div>
      <p class="muted demo-note">Vista demo con datos de ejemplo. En producción estos números salen de decision_log / agent_lessons en tiempo real.</p>`;
  }

  // ── Vista Track Record (Task 8-b: la vitrina pública) ─────────────
  function fmtPct(v) {
    return v === null || v === undefined ? '—' : (v * 100).toFixed(0) + '%';
  }
  function fmtPnl(v) {
    return v === null || v === undefined ? '—' : (v >= 0 ? '+' : '') + v;
  }

  async function loadTrackRecordView() {
    const container = document.getElementById('trackrecord-content');
    let tr;
    try {
      const resp = await fetch('/api/trackrecord');
      tr = await resp.json();
    } catch (err) {
      container.innerHTML = `<div class="glass-panel brain-card"><div class="tr-vacio">No se pudo cargar el Track Record (${err.message}).</div></div>`;
      trackRecordLoaded = true;
      return;
    }
    trackRecordLoaded = true;
    if (tr && tr.demo) setModeBadge('DEMO');

    const empty = !tr.totalDecisiones;
    if (empty) {
      container.innerHTML = `
        <div class="glass-panel brain-card wide">
          <h3>🏆 Track Record</h3>
          <div class="tr-vacio">
            Aún no hay decisiones auditadas.<br>
            Cuando el agente ejecute su primer pipeline SMC, aquí verás su win rate, expectancy
            y el <b>top 5 de "por qué NO operó"</b> — cada WAIT/REVIEW queda auditado con su motivo.
          </div>
        </div>`;
      return;
    }

    const wrClass = tr.winRate === null ? '' : (tr.winRate >= 0.5 ? 'pos' : 'neg');
    const expClass = tr.expectancyPct === null ? '' : (tr.expectancyPct >= 0 ? 'pos' : 'neg');
    const racha = tr.rachaActual === 0 ? '—' : (tr.rachaActual > 0 ? `+${tr.rachaActual} ✅` : `${tr.rachaActual} ❌`);

    const spark = (tr.serieTemporal || []);
    const maxAbs = Math.max(1, ...spark.map((p) => Math.abs(p.pnlAcumulado)));
    const sparkHtml = spark.length
      ? `<div class="tr-spark">${spark.slice(-40).map((p) =>
          `<i class="${p.pnlAcumulado < 0 ? 'down' : ''}" style="height:${Math.max(4, (Math.abs(p.pnlAcumulado) / maxAbs) * 44)}px" title="${p.fecha}: ${fmtPnl(p.pnlAcumulado)} acumulado"></i>`).join('')}</div>`
      : '';

    const razones = (tr.topRazonesEspera || []);
    const razonesHtml = razones.length
      ? `<ul class="tr-razones">${razones.map((r) =>
          `<li><span>${r.razon}</span><span class="conteo">×${r.conteo}</span></li>`).join('')}</ul>`
      : '<div class="tr-vacio">Sin esperas auditadas todavía.</div>';

    const symbols = (tr.symbols || []).slice(0, 12);
    const tablaHtml = symbols.length
      ? `<table class="tr-tabla">
          <thead><tr><th>Símbolo</th><th class="num">Decisiones</th><th class="num">Ejecutadas</th><th class="num">Cerradas</th><th class="num">W/L</th><th class="num">Win rate</th><th class="num">PnL acum.</th></tr></thead>
          <tbody>${symbols.map((s) =>
            `<tr><td><b>${s.symbol}</b></td><td class="num">${s.decisiones}</td><td class="num">${s.ejecutadas}</td><td class="num">${s.settled}</td><td class="num">${s.wins}/${s.losses}</td><td class="num">${fmtPct(s.winRate)}</td><td class="num ${s.pnl >= 0 ? 'pos' : 'neg'}">${fmtPnl(s.pnl)}</td></tr>`).join('')}</tbody>
        </table>`
      : '<div class="tr-vacio">Sin símbolos todavía.</div>';

    container.innerHTML = `
      <div class="tr-grid">
        <div class="tr-card"><span>Win rate (cerradas)</span><b class="${wrClass}">${fmtPct(tr.winRate)}</b></div>
        <div class="tr-card"><span>Expectancy media</span><b class="${expClass}">${tr.expectancyPct === null ? '—' : fmtPnl(tr.expectancyPct)}</b></div>
        <div class="tr-card"><span>Decisiones totales</span><b>${tr.totalDecisiones}</b></div>
        <div class="tr-card"><span>Racha actual</span><b>${racha}</b></div>
      </div>
      <div class="brain-grid">
        <div class="glass-panel brain-card">
          <h3>🚦 Por qué NO operó — top motivos de espera</h3>
          ${razonesHtml}
        </div>
        <div class="glass-panel brain-card">
          <h3>📊 Resumen por acción</h3>
          <div class="stats-grid">
            <div><span>🚀 EXECUTE</span><b>${tr.porAccion.EXECUTE ?? 0}</b></div>
            <div><span>⏳ WAIT</span><b>${tr.porAccion.WAIT ?? 0}</b></div>
            <div><span>🔍 REVIEW</span><b>${tr.porAccion.REVIEW ?? 0}</b></div>
            <div><span>🛑 ABORTED</span><b>${tr.porAccion.ABORTED ?? 0}</b></div>
            <div><span>Cerradas (W/L)</span><b>${tr.settledConPnl} (${tr.wins}/${tr.losses})</b></div>
            <div><span>PnL acumulado</span><b class="${tr.totalPnl >= 0 ? 'pos' : 'neg'}">${fmtPnl(tr.totalPnl)}</b></div>
            <div><span>Mejor símbolo</span><b class="pos">${tr.mejorSimbolo ? `${tr.mejorSimbolo.symbol} (${fmtPnl(tr.mejorSimbolo.pnl)})` : '—'}</b></div>
            <div><span>Peor símbolo</span><b class="neg">${tr.peorSimbolo ? `${tr.peorSimbolo.symbol} (${fmtPnl(tr.peorSimbolo.pnl)})` : '—'}</b></div>
          </div>
          ${sparkHtml}
        </div>
        <div class="glass-panel brain-card wide">
          <h3>🗂️ Detalle por símbolo</h3>
          ${tablaHtml}
        </div>
      </div>
      <p class="muted demo-note">
        ${tr.demo ? 'Datos de DEMOSTRACIÓN (modo preview).' : 'Datos reales de decision_log.'}
        ${tr.ultimoBrainScore !== null && tr.ultimoBrainScore !== undefined ? `Brain Score actual: ${tr.ultimoBrainScore}/100.` : ''}
        Historial descriptivo y educativo: <b>no constituye una promesa ni proyección de rentabilidad futura</b>.
      </p>`;
  }
});
