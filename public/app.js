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
});
