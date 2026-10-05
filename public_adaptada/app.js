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
  const inputArea = document.getElementById('input-area');
  const viewTitle = document.getElementById('view-title');
  const viewSubtitle = document.getElementById('view-subtitle');
  let brainLoaded = false;

  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
      item.classList.add('active');
      const view = item.dataset.view;
      if (view === 'brain') {
        chatWrapper.hidden = true;
        brainView.hidden = false;
        inputArea.style.display = 'none';
        viewTitle.textContent = 'Centro de Mando del Agente';
        viewSubtitle.textContent = 'Observabilidad en vivo · Pipeline SOP v3.1 · Auto-mejora';
        if (!brainLoaded) loadBrainView().catch(console.error);
      } else {
        brainView.hidden = true;
        chatWrapper.hidden = false;
        inputArea.style.display = '';
        viewTitle.textContent = 'Analista Senior SMC';
        viewSubtitle.textContent = 'Conectado a MetaApi | Nvidia NIM 120b';
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
});
