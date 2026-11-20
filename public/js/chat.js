(() => {
    const marketSelect = document.getElementById('chat-market');
    const roomTitle = document.getElementById('chat-room-title');
    const messagesElement = document.getElementById('chat-messages');
    const form = document.getElementById('chat-form');
    const input = document.getElementById('chat-input');
    const send = document.getElementById('chat-send');
    const status = document.getElementById('chat-status');
    const state = { symbol: '', markets: [], wallet: '', token: '', expiresAt: 0, sending: false, generation: 0 };

    function escapeHTML(value) {
        return String(value ?? '').replace(/[&<>"']/g, character => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[character]);
    }

    function updatePostingState() {
        const sessionReady = Boolean(state.wallet && state.token && state.expiresAt > Date.now());
        input.disabled = !sessionReady;
        send.disabled = !sessionReady || state.sending;
        if (!status.classList.contains('is-error')) {
            status.textContent = sessionReady
                ? 'Posting requires an active, unlocked trading account. Slow mode: one message per minute.'
                : 'Anyone can read. Open this chat from the signed-in trading terminal to post.';
        }
    }

    function renderMessages(messages) {
        const wasNearBottom = messagesElement.scrollHeight - messagesElement.scrollTop - messagesElement.clientHeight < 48;
        messagesElement.innerHTML = messages.length ? messages.map(message => {
            const username = message.username || message.display_name || 'Trader';
            const created = new Date(`${String(message.created_at || '').replace(' ', 'T')}Z`);
            const time = Number.isNaN(created.getTime()) ? '' : created.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            const avatar = message.profile_image_url
                ? `<img src="${escapeHTML(message.profile_image_url)}" alt="" referrerpolicy="no-referrer">`
                : `<span class="chat-player-avatar">${escapeHTML(username.slice(0, 1).toUpperCase())}</span>`;
            return `<article class="chat-message">
                <span class="chat-author-wrap">
                    <button class="chat-author" type="button" aria-label="View ${escapeHTML(username)} player card">
                        ${escapeHTML(username)}
                        <span class="chat-player-card" role="tooltip">
                            ${avatar}
                            <span class="chat-player-details">
                                <strong>${escapeHTML(username)}</strong>
                                <small>Rank: ${Number(message.battlepass_level) ? `Level ${Number(message.battlepass_level)}` : 'Unranked'} · ${Number(message.battlepass_xp || 0).toLocaleString()} XP · ${Number(message.battlepass_points || 0).toLocaleString()} points</small>
                                <span class="chat-player-rank">Title: ${escapeHTML(message.battlepass_title || 'BlastrrPass player')}</span>
                                <small>Total payouts: $${Number(message.total_payouts || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT</small>
                                <small>Referral code: ${escapeHTML(message.referral_code || '—')}</small>
                            </span>
                        </span>
                    </button>
                </span>
                <time class="chat-time">${escapeHTML(time)}</time>
                <span class="chat-message-body">${escapeHTML(message.body)}</span>
            </article>`;
        }).join('') : '<p class="chat-empty">No messages yet. Start the conversation.</p>';
        if (wasNearBottom || messages.length <= 1) messagesElement.scrollTop = messagesElement.scrollHeight;
    }

    async function loadMessages() {
        const generation = state.generation;
        if (!state.symbol) return;
        try {
            const response = await fetch(`/api/chat/messages?symbol=${encodeURIComponent(state.symbol)}`);
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Unable to load public chat.');
            if (generation === state.generation) renderMessages(Array.isArray(data.messages) ? data.messages : []);
        } catch (error) {
            if (generation !== state.generation) return;
            messagesElement.innerHTML = '<p class="chat-empty">Unable to load this market’s chat room.</p>';
            status.textContent = error.message || 'Unable to load public chat.';
            status.classList.add('is-error');
        }
    }

    async function postMessage(event) {
        event.preventDefault();
        const message = input.value.trim();
        if (!message || !state.token || state.expiresAt <= Date.now()) {
            updatePostingState();
            return;
        }
        state.sending = true;
        status.classList.remove('is-error');
        status.textContent = 'Sending…';
        updatePostingState();
        try {
            const response = await fetch('/api/chat/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
                body: JSON.stringify({ symbol: state.symbol, message })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Unable to send your message.');
            input.value = '';
            status.textContent = 'Message sent.';
            await loadMessages();
        } catch (error) {
            status.textContent = error.message || 'Unable to send your message.';
            status.classList.add('is-error');
        } finally {
            state.sending = false;
            updatePostingState();
        }
    }

    async function loadMarkets() {
        const [cryptoResponse, forexResponse] = await Promise.all([
            fetch('/config/markets.json'),
            fetch('/config/forexMarkets.json')
        ]);
        if (!cryptoResponse.ok || !forexResponse.ok) throw new Error('Unable to load market rooms.');
        const [cryptoMarkets, forexMarkets] = await Promise.all([
            cryptoResponse.json(),
            forexResponse.json()
        ]);
        if (!Array.isArray(cryptoMarkets) || !Array.isArray(forexMarkets)) throw new Error('Market room configuration is invalid.');
        state.markets = [...cryptoMarkets, ...forexMarkets].filter(market => market.enabled !== false);
        marketSelect.innerHTML = state.markets.map(market =>
            `<option value="${escapeHTML(market.symbol)}">${escapeHTML(market.label || market.symbol)}</option>`
        ).join('');
        const requestedSymbol = new URLSearchParams(location.search).get('symbol');
        state.symbol = state.markets.some(market => market.symbol === requestedSymbol)
            ? requestedSymbol
            : state.markets[0]?.symbol || '';
        marketSelect.value = state.symbol;
        updateRoom();
        messagesElement.innerHTML = '<p class="chat-empty">Loading room messages…</p>';
        await loadMessages();
    }

    function updateRoom() {
        const market = state.markets.find(item => item.symbol === state.symbol);
        roomTitle.textContent = `${market?.label || state.symbol || 'Market'} chat`;
        document.title = `${market?.label || state.symbol || 'Market'} Chat · Blastrr`;
    }

    marketSelect.addEventListener('change', () => {
        state.symbol = marketSelect.value;
        state.generation++;
        updateRoom();
        messagesElement.innerHTML = '<p class="chat-empty">Loading room messages…</p>';
        loadMessages();
    });
    form.addEventListener('submit', postMessage);

    window.addEventListener('message', event => {
        if (event.origin !== window.location.origin || event.source !== window.opener ||
            event.data?.type !== 'BLASTRR_CHAT_SESSION' ||
            typeof event.data.wallet !== 'string' || typeof event.data.token !== 'string') return;
        state.wallet = event.data.wallet;
        state.token = event.data.token;
        state.expiresAt = Number(event.data.expiresAt);
        status.classList.remove('is-error');
        updatePostingState();
    });

    if (window.opener) {
        const readyTimer = setInterval(() => {
            if (!window.opener || window.opener.closed) return clearInterval(readyTimer);
            window.opener.postMessage({ type: 'BLASTRR_CHAT_READY' }, window.location.origin);
        }, 300);
        setTimeout(() => clearInterval(readyTimer), 15000);
        window.addEventListener('message', event => {
            if (event.origin === window.location.origin && event.source === window.opener &&
                event.data?.type === 'BLASTRR_CHAT_SESSION') clearInterval(readyTimer);
        });
    }

    updatePostingState();
    loadMarkets().catch(error => {
        status.textContent = error.message || 'Unable to open market chat.';
        status.classList.add('is-error');
    });
    setInterval(() => {
        if (!document.hidden) loadMessages();
    }, 10000);
})();
