(() => {
  'use strict';

  // ---------- Sabitler ----------
  const SUITS = [
    { key: 'S', sym: '♠', red: false },
    { key: 'H', sym: '♥', red: true },
    { key: 'D', sym: '♦', red: true },
    { key: 'C', sym: '♣', red: false },
  ];
  const SUIT_BY_KEY = Object.fromEntries(SUITS.map((s) => [s.key, s]));
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const TEN_VALUES = ['10', 'J', 'Q', 'K'];
  const DECK_SIZE = 52;
  const START_BALANCE = 1000;
  const MIN_CHIP = 10;
  const MAX_HANDS = 4;
  const DEAL_MS = 420;
  const SHUFFLE_MS = 1700;
  const STORAGE_KEY = 'gercek-deste-blackjack-v1';

  const RESULT_LABEL = {
    blackjack: 'Blackjack',
    win: 'Kazandı',
    lose: 'Kaybetti',
    push: 'Berabere',
    bust: 'Battı',
  };

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const el = {
    balance: $('balance'),
    bet: $('bet'),
    dealerCards: $('dealer-cards'),
    dealerTotal: $('dealer-total'),
    hands: $('player-hands'),
    message: $('message'),
    betting: $('betting-controls'),
    actions: $('action-controls'),
    finished: $('finished-controls'),
    chips: [...document.querySelectorAll('[data-chip]')],
    deal: $('btn-deal'),
    clear: $('btn-clear'),
    rebet: $('btn-rebet'),
    refill: $('btn-refill'),
    hit: $('btn-hit'),
    stand: $('btn-stand'),
    double: $('btn-double'),
    split: $('btn-split'),
    next: $('btn-next'),
    reset: $('btn-reset'),
    deckNumber: $('deck-number'),
    deckRemaining: $('deck-remaining'),
    deckProgress: $('deck-progress'),
    shoe: $('shoe'),
    tracker: $('tracker'),
    seenCount: $('seen-count'),
    trackerStats: $('tracker-stats'),
    history: $('history'),
    overlay: $('shuffle-overlay'),
    overlayDeckNo: $('shuffle-deck-no'),
  };

  // ---------- Yardımcılar ----------
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wait = (ms) => new Promise((r) => setTimeout(r, reduceMotion ? Math.min(ms, 80) : ms));
  const fmt = (n) => n.toLocaleString('tr-TR', { maximumFractionDigits: 1 });

  const rankOf = (id) => id.split('-')[0];
  const suitOf = (id) => SUIT_BY_KEY[id.split('-')[1]];

  function cardValue(id) {
    const r = rankOf(id);
    if (r === 'A') return 11;
    if (TEN_VALUES.includes(r)) return 10;
    return Number(r);
  }

  function handTotal(cards) {
    let total = 0;
    let aces = 0;
    for (const c of cards) {
      total += cardValue(c.id);
      if (rankOf(c.id) === 'A') aces++;
    }
    while (total > 21 && aces > 0) {
      total -= 10;
      aces--;
    }
    return { total, soft: aces > 0 };
  }

  function totalLabel(cards) {
    const { total, soft } = handTotal(cards);
    return soft && total < 21 ? `${total - 10} / ${total}` : String(total);
  }

  const isBlackjack = (hand) => !hand.split && hand.cards.length === 2 && handTotal(hand.cards).total === 21;

  // Kriptografik olarak güvenli, modulo sapması olmayan tam sayı: [0, max)
  function randomInt(max) {
    const c = window.crypto;
    if (!c || !c.getRandomValues) return Math.floor(Math.random() * max);
    const buf = new Uint32Array(1);
    const limit = Math.floor(0x100000000 / max) * max;
    let x;
    do {
      c.getRandomValues(buf);
      x = buf[0];
    } while (x >= limit);
    return x % max;
  }

  function freshDeck() {
    const cards = [];
    for (const s of SUITS) for (const r of RANKS) cards.push(`${r}-${s.key}`);
    return cards;
  }

  // Fisher–Yates karıştırma
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // ---------- Durum ----------
  function freshState() {
    return {
      balance: START_BALANCE,
      pendingBet: 0,
      lastBet: 0,
      deckNumber: 0,
      deck: [], // destenin üstü = dizinin sonu
      seen: [], // bu desteden yüzü açılmış kartlar
      dealer: [],
      hands: [],
      active: 0,
      phase: 'betting', // betting | dealing | playing | dealer | finished
      message: { text: 'Bahsini koy ve dağıt', tone: '' },
      history: [],
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || typeof s.balance !== 'number' || !Array.isArray(s.deck) || !Array.isArray(s.hands)) return null;
      if (!['betting', 'playing', 'finished'].includes(s.phase)) return null;
      return { ...freshState(), ...s };
    } catch {
      return null;
    }
  }

  // Sadece kararlı anlarda kaydedilir; animasyon ortasında yenilenirse son kararlı duruma dönülür.
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* depolama yoksa oyun yine çalışır */
    }
  }

  let state = load() || freshState();
  let busy = false;

  const setMessage = (text, tone = '') => {
    state.message = { text, tone };
  };
  const currentHand = () => state.hands[state.active];

  // ---------- Deste ----------
  async function openNewDeck() {
    state.deckNumber += 1;
    state.deck = shuffle(freshDeck());
    state.seen = [];
    el.overlayDeckNo.textContent = `#${state.deckNumber}`;
    el.overlay.hidden = false;
    render();
    await wait(SHUFFLE_MS);
    el.overlay.hidden = true;
  }

  async function draw(faceDown = false) {
    if (state.deck.length === 0) {
      const prev = state.message;
      setMessage(`Deste #${state.deckNumber} bitti — yeni deste açılıyor`, 'info');
      render();
      await wait(900);
      await openNewDeck();
      setMessage(prev.text, prev.tone);
    }
    const id = state.deck.pop();
    if (!faceDown) state.seen.push(id);
    return { id, deck: state.deckNumber, down: faceDown, fresh: true };
  }

  function revealHole() {
    const hole = state.dealer.find((c) => c.down);
    if (!hole) return;
    hole.down = false;
    hole.flip = true;
    // Kapalı kart eski desteden geldiyse yeni destenin takibine eklenmez
    if (hole.deck === state.deckNumber) state.seen.push(hole.id);
  }

  // ---------- Oyun akışı ----------
  const canAct = () => !busy && state.phase === 'playing' && currentHand() && !currentHand().done;

  const canDouble = (h) => h && h.cards.length === 2 && !h.splitAces && state.balance >= h.bet;

  const canSplit = (h) =>
    h &&
    h.cards.length === 2 &&
    !h.splitAces &&
    state.hands.length < MAX_HANDS &&
    cardValue(h.cards[0].id) === cardValue(h.cards[1].id) &&
    state.balance >= h.bet;

  function promptMove() {
    const h = currentHand();
    const prefix = state.hands.length > 1 ? `El ${state.active + 1}/${state.hands.length} · ` : '';
    setMessage(`${prefix}Toplam ${totalLabel(h.cards)} · Hamleni seç`);
  }

  async function deal() {
    if (busy || state.phase !== 'betting') return;
    const bet = state.pendingBet;
    if (bet <= 0 || bet > state.balance) return;

    busy = true;
    state.balance -= bet;
    state.lastBet = bet;
    state.pendingBet = 0;
    state.hands = [{ cards: [], bet, split: false, splitAces: false, doubled: false, done: false, result: null, payout: 0 }];
    state.dealer = [];
    state.active = 0;
    state.phase = 'dealing';
    setMessage('Kartlar dağıtılıyor…');
    render();

    const hand = state.hands[0];
    hand.cards.push(await draw());
    render();
    await wait(DEAL_MS);
    state.dealer.push(await draw());
    render();
    await wait(DEAL_MS);
    hand.cards.push(await draw());
    render();
    await wait(DEAL_MS);
    state.dealer.push(await draw(true));
    render();
    await wait(DEAL_MS);

    const playerBJ = isBlackjack(hand);
    const dealerBJ = handTotal(state.dealer).total === 21;
    const upValue = cardValue(state.dealer[0].id);

    if (playerBJ || dealerBJ) {
      revealHole();
      render();
      await wait(DEAL_MS);
      settle();
      return;
    }

    state.phase = 'playing';
    promptMove();
    if (upValue >= 10) {
      setMessage(`Krupiye kapalı karta baktı: blackjack yok · ${state.message.text}`);
    }
    busy = false;
    save();
    render();
  }

  async function hit() {
    if (!canAct()) return;
    busy = true;
    const h = currentHand();
    h.cards.push(await draw());
    render();
    await wait(DEAL_MS);
    const { total } = handTotal(h.cards);
    if (total >= 21) {
      h.done = true;
      if (total > 21) h.result = 'bust';
      await nextHand();
    } else {
      finishAction();
    }
  }

  async function stand() {
    if (!canAct()) return;
    busy = true;
    currentHand().done = true;
    await nextHand();
  }

  async function doubleDown() {
    if (!canAct() || !canDouble(currentHand())) return;
    busy = true;
    const h = currentHand();
    state.balance -= h.bet;
    h.bet *= 2;
    h.doubled = true;
    render();
    h.cards.push(await draw());
    render();
    await wait(DEAL_MS);
    h.done = true;
    if (handTotal(h.cards).total > 21) h.result = 'bust';
    await nextHand();
  }

  async function split() {
    if (!canAct() || !canSplit(currentHand())) return;
    busy = true;
    const h = currentHand();
    const aces = rankOf(h.cards[0].id) === 'A';
    state.balance -= h.bet;
    const second = h.cards.pop();
    const other = { cards: [second], bet: h.bet, split: true, splitAces: aces, doubled: false, done: false, result: null, payout: 0 };
    h.split = true;
    h.splitAces = aces;
    state.hands.splice(state.active + 1, 0, other);
    render();
    await wait(250);

    h.cards.push(await draw());
    render();
    await wait(DEAL_MS);

    if (aces) {
      // Bölünen aslara birer kart verilir ve eller kapanır
      other.cards.push(await draw());
      render();
      await wait(DEAL_MS);
      h.done = true;
      other.done = true;
      await nextHand();
    } else if (handTotal(h.cards).total === 21) {
      h.done = true;
      await nextHand();
    } else {
      finishAction();
    }
  }

  function finishAction() {
    promptMove();
    busy = false;
    save();
    render();
  }

  async function nextHand() {
    for (;;) {
      if (!currentHand() || currentHand().done) {
        state.active++;
      }
      const h = currentHand();
      if (!h) return dealerTurn();
      if (h.done) continue;
      if (h.cards.length === 1) {
        render();
        await wait(250);
        h.cards.push(await draw());
        render();
        await wait(DEAL_MS);
      }
      if (handTotal(h.cards).total === 21) {
        h.done = true;
        continue;
      }
      state.phase = 'playing';
      return finishAction();
    }
  }

  async function dealerTurn() {
    state.phase = 'dealer';
    setMessage('Krupiye oynuyor…');
    revealHole();
    render();
    await wait(DEAL_MS + 150);

    const anyAlive = state.hands.some((h) => handTotal(h.cards).total <= 21);
    if (anyAlive) {
      while (handTotal(state.dealer).total < 17) {
        state.dealer.push(await draw());
        render();
        await wait(DEAL_MS + 100);
      }
    }
    settle();
  }

  function settle() {
    const d = handTotal(state.dealer).total;
    const dealerBJ = state.dealer.length === 2 && d === 21;
    const dealerBust = d > 21;
    let staked = 0;
    let returned = 0;

    for (const h of state.hands) {
      const t = handTotal(h.cards).total;
      const bj = isBlackjack(h);
      let result;
      let payout = 0;
      if (t > 21) result = 'bust';
      else if (bj && !dealerBJ) { result = 'blackjack'; payout = h.bet * 2.5; }
      else if (dealerBJ && !bj) result = 'lose';
      else if (bj && dealerBJ) { result = 'push'; payout = h.bet; }
      else if (dealerBust || t > d) { result = 'win'; payout = h.bet * 2; }
      else if (t < d) result = 'lose';
      else { result = 'push'; payout = h.bet; }
      h.result = result;
      h.payout = payout;
      h.done = true;
      staked += h.bet;
      returned += payout;
    }

    state.balance += returned;
    const net = returned - staked;
    const tone = net > 0 ? 'win' : net < 0 ? 'lose' : 'push';

    let dealerText;
    if (dealerBJ) dealerText = 'Krupiye blackjack yaptı';
    else if (dealerBust) dealerText = `Krupiye battı (${d})`;
    else dealerText = `Krupiye ${d}`;
    if (state.hands.length === 1 && state.hands[0].result === 'blackjack') dealerText = 'Blackjack!';
    if (state.hands.length === 1 && state.hands[0].result === 'bust') dealerText = `Battın (${handTotal(state.hands[0].cards).total})`;

    const netText = net > 0 ? `+${fmt(net)} kazandın` : net < 0 ? `${fmt(-net)} kaybettin` : 'Bahsin iade edildi';
    setMessage(`${dealerText} · ${netText}`, tone);

    const summary = state.hands.map((h) => RESULT_LABEL[h.result]).join(', ');
    state.history.unshift({ deck: state.deckNumber, summary, net, tone });
    state.history = state.history.slice(0, 12);

    state.phase = 'finished';
    busy = false;
    save();
    render();
  }

  function newRound() {
    if (busy || state.phase !== 'finished') return;
    state.phase = 'betting';
    state.hands = [];
    state.dealer = [];
    state.active = 0;
    state.pendingBet = state.lastBet && state.lastBet <= state.balance ? state.lastBet : 0;
    const left = state.deck.length;
    const deckNote = left < 15 ? ` · Destede ${left} kart kaldı` : '';
    setMessage((state.pendingBet ? 'Aynı bahisle devam için Dağıt' : 'Bahsini koy ve dağıt') + deckNote);
    save();
    render();
  }

  // ---------- Bahis ----------
  function addChip(value) {
    if (busy || state.phase !== 'betting') return;
    if (state.pendingBet + value > state.balance) return;
    state.pendingBet += value;
    setMessage('Hazır olduğunda Dağıt');
    save();
    render();
  }

  function clearBet() {
    if (busy || state.phase !== 'betting') return;
    state.pendingBet = 0;
    setMessage('Bahsini koy ve dağıt');
    save();
    render();
  }

  function rebet() {
    if (busy || state.phase !== 'betting' || !state.lastBet || state.lastBet > state.balance) return;
    state.pendingBet = state.lastBet;
    save();
    render();
  }

  function refill() {
    if (busy || state.phase !== 'betting') return;
    state.balance = START_BALANCE;
    state.pendingBet = 0;
    setMessage('Bakiye yenilendi · Bahsini koy ve dağıt', 'info');
    save();
    render();
  }

  async function resetGame() {
    if (busy) return;
    if (!window.confirm('Bakiye, geçmiş ve deste sıfırlansın mı?')) return;
    state = freshState();
    busy = true;
    await openNewDeck();
    busy = false;
    save();
    render();
  }

  // ---------- Çizim ----------
  function cardEl(card) {
    const d = document.createElement('div');
    d.className = 'card';
    if (card.fresh) d.classList.add('deal');
    if (card.flip) d.classList.add('flip');
    if (card.down) {
      d.classList.add('back');
      d.setAttribute('aria-label', 'Kapalı kart');
      return d;
    }
    const r = rankOf(card.id);
    const s = suitOf(card.id);
    if (s.red) d.classList.add('red');
    d.setAttribute('aria-label', `${r}${s.sym}`);
    const center = ['J', 'Q', 'K'].includes(r)
      ? `<span class="frame">${r}<small>${s.sym}</small></span>`
      : s.sym;
    d.innerHTML =
      `<span class="corner tl"><b>${r}</b><i>${s.sym}</i></span>` +
      `<span class="pip">${center}</span>` +
      `<span class="corner br"><b>${r}</b><i>${s.sym}</i></span>`;
    return d;
  }

  function renderCards(container, cards) {
    container.replaceChildren(...cards.map(cardEl));
  }

  function pill(text, cls = '') {
    const p = document.createElement('span');
    p.className = `pill ${cls}`.trim();
    p.textContent = text;
    return p;
  }

  function handEl(h, i) {
    const wrap = document.createElement('div');
    wrap.className = 'hand';
    const multi = state.hands.length > 1;
    if (multi && state.phase === 'playing' && i === state.active) wrap.classList.add('active');
    if (multi && state.phase === 'playing' && i !== state.active) wrap.classList.add('dim');

    const cards = document.createElement('div');
    cards.className = 'cards';
    renderCards(cards, h.cards);

    const foot = document.createElement('div');
    foot.className = 'hand-foot';
    const t = handTotal(h.cards).total;
    if (isBlackjack(h)) foot.append(pill('Blackjack', 'bj'));
    else if (h.cards.length) foot.append(pill(totalLabel(h.cards), t > 21 ? 'over' : ''));
    foot.append(pill(`Bahis ${fmt(h.bet)}${h.doubled ? ' ×2' : ''}`, 'bet'));
    if (state.phase === 'finished' && h.result) {
      const gain = h.payout - h.bet;
      const suffix = gain > 0 ? ` +${fmt(gain)}` : '';
      foot.append(pill(RESULT_LABEL[h.result] + suffix, `result ${h.result}`));
    }

    wrap.append(cards, foot);
    return wrap;
  }

  function betSpotEl() {
    const spot = document.createElement('div');
    spot.className = 'bet-spot';
    spot.innerHTML = `<small>BAHİS</small><strong>${fmt(state.pendingBet)}</strong>`;
    return spot;
  }

  const trackerCells = [];
  function buildTracker() {
    const frag = document.createDocumentFragment();
    for (const s of SUITS) {
      const label = document.createElement('div');
      label.className = `tcell suit${s.red ? ' red' : ''}`;
      label.textContent = s.sym;
      frag.append(label);
      for (const r of RANKS) {
        const c = document.createElement('div');
        c.className = `tcell${s.red ? ' red' : ''}`;
        c.dataset.id = `${r}-${s.key}`;
        c.textContent = r;
        c.title = `${r}${s.sym}`;
        trackerCells.push(c);
        frag.append(c);
      }
    }
    el.tracker.append(frag);
  }

  function renderDeck() {
    const remaining = state.deck.length;
    el.deckNumber.textContent = `#${state.deckNumber}`;
    el.deckRemaining.textContent = `${remaining} / ${DECK_SIZE} kart`;
    el.deckProgress.style.width = `${(remaining / DECK_SIZE) * 100}%`;

    if (remaining === 0) {
      el.shoe.innerHTML = '<div class="shoe-empty">Boş</div>';
    } else {
      const layers = Math.ceil(remaining / 3);
      const frag = document.createDocumentFragment();
      for (let i = 0; i < layers; i++) {
        const l = document.createElement('div');
        l.className = 'layer';
        l.style.setProperty('--i', i);
        frag.append(l);
      }
      el.shoe.replaceChildren(frag);
    }

    const seen = new Set(state.seen);
    for (const c of trackerCells) c.classList.toggle('seen', seen.has(c.dataset.id));
    el.seenCount.textContent = `${seen.size} açıldı`;
    const seenAces = state.seen.filter((id) => rankOf(id) === 'A').length;
    const seenTens = state.seen.filter((id) => TEN_VALUES.includes(rankOf(id))).length;
    el.trackerStats.textContent =
      `Görülmemiş ${DECK_SIZE - seen.size} kart · As: ${4 - seenAces} · 10 değerli: ${16 - seenTens}`;
  }

  function renderHistory() {
    if (!state.history.length) {
      el.history.innerHTML = '<li class="empty">Henüz el oynanmadı</li>';
      return;
    }
    el.history.replaceChildren(
      ...state.history.map((h) => {
        const li = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = `Deste #${h.deck} · ${h.summary}`;
        const amount = document.createElement('b');
        amount.className = h.tone;
        amount.textContent = h.net > 0 ? `+${fmt(h.net)}` : h.net < 0 ? `−${fmt(-h.net)}` : '0';
        li.append(label, amount);
        return li;
      })
    );
  }

  function render() {
    const betting = state.phase === 'betting';

    el.balance.textContent = fmt(state.balance);
    const onTable = betting ? state.pendingBet : state.hands.reduce((a, h) => a + h.bet, 0);
    el.bet.textContent = fmt(onTable);

    renderCards(el.dealerCards, state.dealer);
    const visible = state.dealer.filter((c) => !c.down);
    el.dealerTotal.hidden = visible.length === 0;
    el.dealerTotal.textContent = visible.length
      ? totalLabel(visible) + (state.dealer.some((c) => c.down) ? ' + ?' : '')
      : '';

    if (betting) el.hands.replaceChildren(betSpotEl());
    else el.hands.replaceChildren(...state.hands.map(handEl));

    el.message.textContent = state.message.text;
    el.message.className = `message ${state.message.tone || ''}`.trim();

    // Kontroller
    el.betting.hidden = !betting;
    el.actions.hidden = !['dealing', 'playing', 'dealer'].includes(state.phase);
    el.finished.hidden = state.phase !== 'finished';

    for (const chip of el.chips) {
      chip.disabled = busy || !betting || state.pendingBet + Number(chip.dataset.chip) > state.balance;
    }
    el.deal.disabled = busy || state.pendingBet <= 0;
    el.clear.disabled = busy || state.pendingBet === 0;
    el.rebet.disabled =
      busy || !state.lastBet || state.lastBet > state.balance || state.pendingBet === state.lastBet;
    el.refill.hidden = !(betting && state.balance < MIN_CHIP);

    const h = currentHand();
    const act = canAct();
    el.hit.disabled = !act;
    el.stand.disabled = !act;
    el.double.disabled = !(act && canDouble(h));
    el.split.disabled = !(act && canSplit(h));

    renderDeck();
    renderHistory();

    // Animasyon bayrakları sadece bir kez uygulanır
    for (const c of state.dealer) c.fresh = c.flip = false;
    for (const hand of state.hands) for (const c of hand.cards) c.fresh = c.flip = false;
  }

  // ---------- Olaylar ----------
  el.chips.forEach((chip) => chip.addEventListener('click', () => addChip(Number(chip.dataset.chip))));
  el.deal.addEventListener('click', deal);
  el.clear.addEventListener('click', clearBet);
  el.rebet.addEventListener('click', rebet);
  el.refill.addEventListener('click', refill);
  el.hit.addEventListener('click', hit);
  el.stand.addEventListener('click', stand);
  el.double.addEventListener('click', doubleDown);
  el.split.addEventListener('click', split);
  el.next.addEventListener('click', newRound);
  el.reset.addEventListener('click', resetGame);

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === 'h') hit();
    else if (k === 's') stand();
    else if (k === 'd') doubleDown();
    else if (k === 'p') split();
    else if (k === 'enter') {
      e.preventDefault();
      if (state.phase === 'betting') deal();
      else if (state.phase === 'finished') newRound();
    }
  });

  // ---------- Başlat ----------
  buildTracker();
  render();

  if (state.deckNumber === 0) {
    // İlk açılış: gerçek bir deste açılır ve karılır
    busy = true;
    openNewDeck().then(() => {
      busy = false;
      save();
      render();
    });
  }
})();
