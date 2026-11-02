(() => {
  'use strict';
  if (globalThis.__IT_CONTENT__ || !/^https?:$/.test(location.protocol) || window.top !== window) return;
  const OWN = 'data-it-translation';
  const SKIP = 'script,style,noscript,template,pre,code,input,textarea,select,option,button,nav,header,footer,iframe,canvas,svg,math,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="navigation"],[data-it-translation],#it-translation-root';
  const BLOCK = new Set(['ADDRESS','ARTICLE','ASIDE','BLOCKQUOTE','BODY','DD','DIV','DL','DT','FIGCAPTION','FIGURE','H1','H2','H3','H4','H5','H6','LI','MAIN','OL','P','SECTION','TABLE','TBODY','TD','TH','THEAD','TR','UL']);
  let state = 'original', generation = 0, sessionId = null, records = [], observer = null, configKey = '', cache = new WeakMap(), lastURL = location.href, disposed = false;
  let fatalError = '', notice = '';
  const host = document.createElement('div'); host.id = 'it-translation-root';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host{all:initial!important;position:fixed!important;left:var(--it-pet-x,auto)!important;right:var(--it-pet-right,0)!important;top:var(--it-pet-y,clamp(8px,calc(50% - 58px),calc(100% - 124px)))!important;transition:var(--it-pet-transition,none)!important;z-index:2147483647!important;font:14px/1.5 system-ui,sans-serif!important;color-scheme:light dark}
    *{box-sizing:border-box}button{font:inherit;cursor:pointer}button:focus-visible{outline:3px solid #e99b25;outline-offset:3px}
    .ball{position:relative;display:block;width:82px;height:116px;margin:0;padding:0;border:0;border-radius:20px 0 0 20px;background:transparent;color:#39434a;-webkit-tap-highlight-color:transparent;touch-action:none;user-select:none;cursor:grab}
    .pet{position:absolute;right:0;top:0;display:block;width:82px;height:116px;overflow:visible;filter:drop-shadow(-2px 3px 2px #202a3426);pointer-events:none}
    .ball[data-side=left] .pet{right:auto;left:0;transform:scaleX(-1)}
    .ball[data-side=left] .pet-status{left:auto;right:6px}
    .ball[data-side=left][data-pose=docked] .pet,.ball[data-side=left][data-pose=hidden] .pet{left:-12px}
    .ball[data-side=left][data-pose=docked] .pet-status,.ball[data-side=left][data-pose=hidden] .pet-status{right:18px}
    .pet-hug-body{transition:opacity .28s ease,transform .28s ease}
    .pet-loose{display:none}
    .pet-peek{opacity:0;visibility:hidden;pointer-events:none;transition:opacity .28s ease}
    .pet-idle-eyes{display:none}
    .ball[data-pose=hidden]{width:58px;height:62px}
    .ball[data-pose=hidden] .pet-hug-body{opacity:0;transform:translateX(16px)}
    .ball[data-pose=hidden] .pet-status{opacity:0}
    .ball[data-pose=hidden] .pet-peek{opacity:1;visibility:visible}
    .ball[data-pose=hidden] .pet-head{transform:rotate(-5deg)}
    .ball[data-pose=hidden] .pet-eyes{display:none}
    .ball[data-pose=hidden] .pet-idle-eyes{display:inline}
    .ball[data-pose=dragging]{cursor:grabbing;transition:none}
    .ball[data-pose=dragging] .pet-hug-body,.ball[data-pose=returning] .pet-hug-body{display:none}
    .ball[data-pose=dragging] .pet-loose,.ball[data-pose=returning] .pet-loose{display:inline}
    .ball[data-pose=dragging] .pet-status,.ball[data-pose=returning] .pet-status{opacity:0}
    .ball[data-pose=dragging] .pet-figure{transform-origin:72px 25px;animation:pet-dangle .7s ease-in-out infinite alternate}
    .pet-arm{transform-origin:84px 78px;--pet-stroke-direction:1}
    .pet-arm-back{transform-origin:56px 78px;--pet-stroke-direction:-1}
    .ball[data-pose=dragging] .pet-arm{animation:pet-paddle .72s ease-in-out infinite}
    .ball[data-pose=dragging] .pet-arm-back{animation-delay:-.36s}
    .ball[data-pose=dragging] .pet-leg{transform-origin:59px 118px;animation:pet-flutter .54s ease-in-out infinite}
    .ball[data-pose=dragging] .pet-leg-back{transform-origin:80px 116px;animation-delay:-.27s}
    .ball[data-pose=returning] .pet-figure{animation:pet-hop .16s ease-in-out infinite alternate}
    .ball[data-pose=returning] .pet-leg{transform-origin:72px 118px;animation:pet-step .22s ease-in-out infinite alternate}
    .ball[data-pose=returning] .pet-leg-back{animation-delay:-.22s}
    .ball[data-pose=dragging]~.panel,.ball[data-pose=returning]~.panel{visibility:hidden}
    .pet-body{transform-origin:99px 100px;animation:pet-breathe 4s ease-in-out infinite}
    .pet-head{transform-origin:71px 66px;transition:transform .25s ease}
    .pet-eyes{transform-box:fill-box;transform-origin:center;animation:pet-blink 6s infinite}
    .ball:hover .pet-head,.ball:focus-visible .pet-head{transform:rotate(-7deg) translateY(-2px)}
    .pet-paw{transform-box:fill-box;transform-origin:right center}
    .ball[data-state=loading] .pet-paw{animation:pet-grip .7s ease-in-out infinite alternate}
    .ball[data-state=loading] .pet-paw:nth-of-type(even){animation-delay:-.7s}
    .pet-status{position:absolute;left:6px;top:8px;display:grid;place-items:center;min-width:22px;height:22px;padding:0 4px;border:1.5px solid #c8d5cf;border-radius:9px 9px 3px 9px;background:#f8fcf9;color:#456355;box-shadow:0 2px 5px #202a3412;font-size:11px;font-weight:750;line-height:1;transition:opacity .2s ease;pointer-events:none}
    .ball[data-state=translated] .pet-status{background:#eaf6ee;border-color:#a2cbb0;color:#346749}
    .ball[data-state=loading] .pet-status{background:#fff1d9;border-color:#e5b975}
    .ball[data-state=error] .pet-status,.ball[data-state=partial] .pet-status{background:#fff0e9;border-color:#dc9d85;color:#a23e28}
    .panel{position:fixed;right:90px;top:50%;transform:translateY(-50%);width:230px;max-width:calc(100vw - 102px);max-height:calc(100dvh - 16px);overflow:auto;padding:12px;border:1px solid #9ca3af;border-radius:10px;background:Canvas;color:CanvasText;box-shadow:0 4px 18px #0003;overflow-wrap:anywhere}
    .panel[hidden]{display:none}.message{margin:0 0 8px}.actions{display:flex;flex-wrap:wrap;gap:8px}.actions button{border:1px solid #9ca3af;border-radius:5px;background:Canvas;color:CanvasText;padding:3px 8px}
    @keyframes pet-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.015,1.012)}}
    @keyframes pet-blink{0%,43%,47%,100%{transform:scaleY(1)}45%{transform:scaleY(.12)}}
    @keyframes pet-grip{from{transform:scaleX(1)}to{transform:scaleX(.94)}}
    @keyframes pet-dangle{from{transform:rotate(-9deg) translateY(-3px)}to{transform:rotate(6deg) translateY(-3px)}}
    @keyframes pet-paddle{0%,100%{transform:rotate(calc(var(--pet-stroke-direction) * 10deg))}38%{transform:rotate(calc(var(--pet-stroke-direction) * -48deg)) translateY(-1px)}72%{transform:rotate(calc(var(--pet-stroke-direction) * -18deg)) translateY(2px)}}
    @keyframes pet-flutter{0%,100%{transform:rotate(-20deg) scaleY(.96)}50%{transform:rotate(22deg) translateY(-2px)}}
    @keyframes pet-hop{from{transform:translateY(0)}to{transform:translateY(-4px)}}
    @keyframes pet-step{from{transform:rotate(-16deg)}to{transform:rotate(16deg)}}
    @media(prefers-reduced-motion:reduce){.ball,.pet *,.pet-status{animation:none!important;transition:none!important}}
  `;
  const button = document.createElement('button'); button.className = 'ball'; button.type = 'button';
  // Local vector artwork keeps the pet crisp without external images or requests.
  button.innerHTML = `
    <svg class="pet" viewBox="0 0 112 160" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
      <g class="pet-figure" stroke="#2d3439" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
        <g class="pet-hug-body">
        <path d="M88 78C84 67 93 52 104 48L109 56C101 60 101 74 98 82Z" fill="#343a40"/>
        <path d="M92 101C103 98 109 103 109 112L105 120C97 122 91 116 88 110Z" fill="#343a40"/>
        <g class="pet-body">
          <path d="M72 67C55 70 47 91 53 111C58 128 82 132 96 119C108 108 105 89 95 77C89 70 82 67 72 67Z" fill="#fafbf7"/>
          <path d="M55 96C53 114 68 127 84 123C68 122 63 110 64 97Z" fill="#e3e9e5" stroke="none"/>
          <path d="M63 73C74 65 86 69 95 77C101 83 103 91 103 96C89 94 73 85 59 84Z" fill="#343a40" stroke="none"/>
          <path d="M72 107Q77 110 82 107" fill="none" stroke="#d5ddd7" stroke-width="2"/>
        </g>
        <path d="M83 78C74 79 73 88 80 94C89 102 103 93 108 83L106 74C102 73 99 79 96 82C91 87 89 84 88 81" fill="#343a40"/>
        <path d="M80 112C71 116 75 128 83 133C91 139 103 135 108 127L106 118C102 117 99 122 95 122C91 122 93 114 88 112Z" fill="#343a40"/>
        <path d="M82 119Q81 125 87 128" fill="none" stroke="#535b60" stroke-width="2"/>
        </g>
        <g class="pet-loose">
          <path class="pet-leg pet-leg-back" d="M77 113C88 109 91 125 91 139C91 148 80 149 78 142L74 124Z" fill="#343a40"/>
          <path class="pet-arm pet-arm-back" d="M56 74C46 78 42 92 44 105C45 112 53 113 55 106L62 85Z" fill="#343a40"/>
          <path class="pet-arm" d="M83 74C93 76 100 90 100 103C100 111 92 113 90 105L80 86Z" fill="#343a40"/>
          <path d="M56 72C47 85 48 113 58 123C66 132 85 130 90 116C96 99 91 79 81 72Z" fill="#fafbf7"/>
          <path d="M55 74C61 69 76 68 85 75L90 86C79 93 61 92 51 85Z" fill="#343a40" stroke="none"/>
          <path d="M55 102C55 116 63 125 74 125" fill="none" stroke="#e3e9e5" stroke-width="4"/>
          <path class="pet-leg" d="M58 114C67 112 71 122 68 136L67 145C66 153 55 151 54 144L52 126C51 121 54 116 58 114Z" fill="#343a40"/>
        </g>
        <g class="pet-peek">
          <path d="M76 65C69 70 73 79 81 82C91 86 104 79 112 71V57Z" fill="#343a40"/>
          <path d="M78 71C76 78 83 82 90 81C97 80 102 74 101 69C93 66 84 67 78 71Z" fill="#fafbf7" stroke="none"/>
        </g>
        <g transform="translate(7 0)"><g class="pet-head">
          <circle cx="39" cy="25" r="12" fill="#343a40"/><circle cx="84" cy="24" r="12" fill="#343a40"/>
          <circle cx="39" cy="25" r="5.5" fill="#535b60" stroke="none"/><circle cx="84" cy="24" r="5.5" fill="#535b60" stroke="none"/>
          <path d="M31 47C31 31 45 23 63 24C82 22 96 34 96 49C98 66 84 77 65 77C46 78 29 66 31 47Z" fill="#fafbf7"/>
          <path d="M34 56C39 69 51 73 65 73C80 73 89 66 94 56C92 71 80 77 65 77C49 78 37 70 34 56Z" fill="#e3e9e5" stroke="none"/>
          <ellipse cx="48" cy="47" rx="9" ry="12" transform="rotate(25 48 47)" fill="#343a40" stroke="none"/>
          <ellipse cx="79" cy="46" rx="9" ry="12" transform="rotate(-25 79 46)" fill="#343a40" stroke="none"/>
          <g class="pet-eyes" stroke="none">
            <g fill="#fff"><ellipse cx="50" cy="46" rx="3.6" ry="4.2"/><ellipse cx="77" cy="45" rx="3.6" ry="4.2"/></g>
            <g fill="#20272c"><ellipse cx="51" cy="47" rx="2.4" ry="3"/><ellipse cx="78" cy="46" rx="2.4" ry="3"/></g>
            <g fill="#fff"><circle cx="51.5" cy="45.5" r="1"/><circle cx="78.5" cy="44.5" r="1"/></g>
          </g>
          <g class="pet-idle-eyes" fill="none" stroke="#fafbf7" stroke-width="2.5">
            <path d="M46 47Q49 43 52 47M74 46Q77 42 80 46"/>
          </g>
          <ellipse cx="42" cy="59" rx="5" ry="2.8" fill="#edb8b6" stroke="none"/><ellipse cx="85" cy="58" rx="4.5" ry="2.7" fill="#edb8b6" stroke="none"/>
          <ellipse cx="64" cy="60" rx="12" ry="8" fill="#fff" stroke="none"/>
          <path d="M59 56Q64 53 69 56Q66 62 63 60Z" fill="#2d3439" stroke="none"/>
          <path d="M64 60V63M58 63Q61 67 64 63Q67 67 71 62" fill="none" stroke-width="1.7"/>
        </g></g>
        <g class="pet-peek" fill="#343a40" stroke="#626c70" stroke-width="1.5">
          <path d="M49 75C48 70 52 67 57 69C63 70 65 78 61 81C57 84 50 82 49 75Z"/>
          <path d="M83 73C82 68 87 66 92 69C98 71 98 78 93 81C88 84 83 80 83 73Z"/>
          <g fill="#e6aaa7" stroke="none"><ellipse cx="56" cy="77" rx="3" ry="2.3" transform="rotate(-16 56 77)"/><ellipse cx="90" cy="76" rx="3" ry="2.3" transform="rotate(16 90 76)"/></g>
          <path d="M52 72L53 73M56 71L57 72M86 71L87 72M90 70L91 71" fill="none" stroke="#778185" stroke-width="1.2"/>
        </g>
        <g class="pet-hug-body">
        <path d="M110 38V139" fill="none" stroke="#91a99a99" stroke-width="2.5"/>
        <g fill="#343a40">
          <g class="pet-paw"><path d="M101 46C101 40 107 39 111 42V49C107 48 108 53 105 55C100 56 98 51 101 46Z"/><path d="M106 44Q109 43 111 45M106 48Q109 47 111 49" fill="none" stroke="#778185" stroke-width="1.3"/></g>
          <g class="pet-paw"><path d="M101 76C100 70 107 67 111 71V78C107 77 109 83 105 85C100 87 97 81 101 76Z"/><path d="M106 73Q109 72 111 74M106 77Q109 76 111 78" fill="none" stroke="#778185" stroke-width="1.3"/></g>
          <g class="pet-paw"><path d="M102 106C102 101 108 100 111 103V110C107 109 109 114 105 116C101 117 99 111 102 106Z"/><path d="M107 105Q109 104 111 106M107 109Q109 108 111 110" fill="none" stroke="#778185" stroke-width="1.3"/></g>
          <g class="pet-paw"><path d="M101 126C100 120 107 118 111 121V128C107 127 108 133 104 134C99 135 98 130 101 126Z"/><path d="M106 123Q109 122 111 124M106 127Q109 126 111 128" fill="none" stroke="#778185" stroke-width="1.3"/></g>
        </g>
        </g>
      </g>
    </svg><span class="pet-status" aria-hidden="true"></span>`;
  const status = button.querySelector('.pet-status');
  const panel = document.createElement('div'); panel.className = 'panel'; panel.hidden = true;
  const message = document.createElement('p'); message.className = 'message'; message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
  const actions = document.createElement('div'); actions.className = 'actions';
  const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重试失败内容'; retry.hidden = true;
  const settings = document.createElement('button'); settings.type = 'button'; settings.textContent = '设置';
  actions.append(retry, settings); panel.append(message, actions); shadow.append(style, button, panel); document.documentElement.append(host);
  const PET_WIDTH = 82, PET_HEIGHT = 116, IDLE_DELAY = 4000, RETURN_DURATION = 520;
  let petPose = 'docked', petSide = 'right', petX = Math.max(0, innerWidth - PET_WIDTH), petY = limitPetY(innerHeight / 2 - PET_HEIGHT / 2);
  let idleTimer = 0, returnTimer = 0, pickup = null, ignoreDragClick = false;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  function limitPetY(value) { return Math.max(8, Math.min(value, Math.max(8, innerHeight - PET_HEIGHT - 8))); }
  function setPetPose(value) { petPose = value; button.dataset.pose = value; }
  function setPetSide(value) { petSide = value; button.dataset.side = value; }
  function placePet(x, y) {
    petX = x; petY = limitPetY(y);
    // Custom properties bridge the shadow host's important isolation rules.
    host.style.setProperty('--it-pet-right', 'auto');
    host.style.setProperty('--it-pet-x', `${petX}px`);
    host.style.setProperty('--it-pet-y', `${petY}px`);
  }
  function dockPet() { placePet(petSide === 'left' ? 0 : Math.max(0, innerWidth - (petPose === 'hidden' ? 58 : PET_WIDTH)), petY); }
  function positionPanel() {
    panel.style.left = petSide === 'left' ? '90px' : 'auto';
    panel.style.right = petSide === 'right' ? '90px' : 'auto';
    if (panel.hidden) return;
    const height = panel.getBoundingClientRect().height;
    panel.style.top = `${Math.max(8, Math.min(petY + 48 - height / 2, innerHeight - height - 8))}px`;
    panel.style.transform = 'none';
  }
  function stopIdle() { clearTimeout(idleTimer); idleTimer = 0; }
  function canHidePet() {
    return !disposed && document.visibilityState === 'visible' && petPose === 'docked' && !pickup && state !== 'loading' && panel.hidden && !host.matches(':hover') && !button.matches(':focus-visible');
  }
  function armIdle() {
    stopIdle();
    if (canHidePet()) idleTimer = setTimeout(() => {
      if (!canHidePet()) return;
      setPetPose('hidden'); dockPet();
    }, IDLE_DELAY);
  }
  function revealPet() {
    stopIdle();
    if (petPose === 'hidden') { setPetPose('docked'); dockPet(); }
  }
  function releaseCapture(pointerId) {
    if (button.hasPointerCapture(pointerId)) button.releasePointerCapture(pointerId);
  }
  function stopReturn() {
    clearTimeout(returnTimer); returnTimer = 0;
    const rect = host.getBoundingClientRect();
    host.style.setProperty('--it-pet-transition', 'none');
    if (petPose === 'returning') placePet(rect.left, rect.top);
  }
  function finishDocking() {
    clearTimeout(returnTimer); returnTimer = 0;
    host.style.setProperty('--it-pet-transition', 'none');
    setPetPose('docked'); dockPet(); positionPanel(); armIdle();
  }
  function returnToEdge(immediate = false) {
    stopIdle(); stopReturn();
    setPetSide(petX + PET_WIDTH / 2 < innerWidth / 2 ? 'left' : 'right');
    if (immediate || reducedMotion.matches || disposed) { finishDocking(); return; }
    setPetPose('returning');
    host.getBoundingClientRect();
    host.style.setProperty('--it-pet-transition', `left ${RETURN_DURATION}ms cubic-bezier(.22,.7,.28,1),top ${RETURN_DURATION}ms ease`);
    dockPet();
    returnTimer = setTimeout(finishDocking, RETURN_DURATION);
  }
  function endPickup(immediate = false, cancelled = false) {
    if (!pickup) return;
    const previous = pickup; pickup = null;
    releaseCapture(previous.id);
    if (cancelled) ignoreDragClick = true;
    if (previous.moved) { ignoreDragClick = true; returnToEdge(immediate); }
    else { if (petPose === 'returning') returnToEdge(immediate); else armIdle(); }
  }
  function cancelPetMotion() {
    stopIdle();
    if (pickup) endPickup(true, true);
    if (petPose === 'returning') { stopReturn(); finishDocking(); }
    stopIdle();
  }
  host.addEventListener('pointerenter', event => { if (event.isTrusted) revealPet(); });
  host.addEventListener('pointerleave', event => { if (event.isTrusted) armIdle(); });
  button.addEventListener('focus', revealPet);
  button.addEventListener('blur', armIdle);
  button.addEventListener('dragstart', event => event.preventDefault());
  button.addEventListener('pointerdown', event => {
    if (!event.isTrusted || !event.isPrimary || event.button !== 0 || pickup) return;
    ignoreDragClick = false;
    revealPet(); stopReturn();
    const rect = button.getBoundingClientRect();
    pickup = { id: event.pointerId, startX: event.clientX, startY: event.clientY, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, moved: false };
    button.setPointerCapture(event.pointerId);
  });
  button.addEventListener('pointermove', event => {
    if (!event.isTrusted || !pickup || event.pointerId !== pickup.id) return;
    if (!pickup.moved && Math.hypot(event.clientX - pickup.startX, event.clientY - pickup.startY) <= 6) return;
    pickup.moved = true; ignoreDragClick = true;
    setPetPose('dragging');
    placePet(Math.max(0, Math.min(event.clientX - pickup.offsetX, Math.max(0, innerWidth - PET_WIDTH))), event.clientY - pickup.offsetY);
    event.preventDefault();
  });
  button.addEventListener('pointerup', event => { if (event.isTrusted && pickup?.id === event.pointerId) endPickup(); });
  button.addEventListener('pointercancel', event => { if (event.isTrusted && pickup?.id === event.pointerId) endPickup(true, true); });
  button.addEventListener('lostpointercapture', event => { if (event.isTrusted && pickup?.id === event.pointerId) endPickup(true, true); });
  button.addEventListener('keydown', event => { if (event.isTrusted && event.key === 'Escape' && pickup) endPickup(true, true); });
  addEventListener('blur', () => { if (pickup) endPickup(true, true); });
  addEventListener('resize', () => {
    if (pickup) endPickup(true, true);
    if (petPose === 'returning') { stopReturn(); setPetPose('docked'); }
    dockPet(); positionPanel(); armIdle();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') cancelPetMotion();
    else { dockPet(); positionPanel(); armIdle(); }
  });
  setPetSide('right'); setPetPose('docked'); dockPet();
  function update(text = '') {
    notice = text;
    const titles = { original: '翻译当前网页', loading: '翻译中，点击取消并还原', translated: '显示原文', partial: '显示原文', error: '重新尝试翻译' };
    button.title = titles[state]; button.setAttribute('aria-label', titles[state]); button.dataset.state = state;
    status.textContent = ({ original: '译', loading: '…', translated: '原', partial: '!', error: '!' })[state];
    message.textContent = text; panel.hidden = !text; retry.hidden = state !== 'partial';
    if (text || state === 'loading') revealPet();
    positionPanel(); armIdle();
  }
  function friendly(error) {
    if (error && typeof error.message === 'string' && error.message.trim()) return error.message.slice(0, 240);
    return '连接失败，请检查网络或扩展设置后重试。';
  }
  async function send(payload) {
    try { return await chrome.runtime.sendMessage(payload); }
    catch { return { ok: false, error: { code: 'CONNECTION', message: '无法连接扩展后台，请刷新网页后重试。', fatal: true } }; }
  }
  function normalized(text) { return text.replace(/\s+/g, ' ').trim(); }
  function inClosedDetails(node) {
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      if (parent.tagName !== 'DETAILS' || parent.open) continue;
      const summary = Array.from(parent.children).find(child => child.tagName === 'SUMMARY');
      if (!summary?.contains(node)) return true;
    }
    return false;
  }
  function excluded(element) {
    if (element.matches(SKIP) || element.hidden || element.getAttribute('aria-hidden') === 'true' || element.inert || inClosedDetails(element)) return true;
    const css = getComputedStyle(element);
    return css.display === 'none' || css.visibility === 'hidden' || css.visibility === 'collapse' || css.contentVisibility === 'hidden' || css.opacity === '0';
  }
  function read(node) {
    if (node.nodeType === Node.TEXT_NODE) return inClosedDetails(node) ? '' : node.data;
    if (node.nodeType !== Node.ELEMENT_NODE || excluded(node)) return '';
    if (node.tagName === 'BR') return '\n';
    return Array.from(node.childNodes, read).join('');
  }
  function skipLanguage(text, language) {
    const letters = (text.match(/\p{L}/gu) || []).length;
    const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
    if (!letters) return true;
    if (language === 'zh-CN') return cjk / letters > .3 && !/[\u3040-\u30ff\uac00-\ud7af]/.test(text);
    if (language === 'en') return /^en(?:-|$)/i.test(document.documentElement.lang) && cjk === 0 && (text.match(/[a-z]/gi) || []).length === letters;
    return false;
  }
  function snapshot(language) {
    const found = [];
    function visit(container) {
      if (excluded(container)) return;
      let run = [];
      const hasBlocks = Array.from(container.children).some(child => BLOCK.has(child.tagName));
      function flush() {
        const nodes = run; run = [];
        const text = normalized(nodes.map(read).join(''));
        if (!text || skipLanguage(text, language)) return;
        const parts = []; for (let offset = 0; offset < text.length; offset += 3000) parts.push({ id: `${found.length}_${parts.length}`, text: text.slice(offset, offset + 3000), translation: null, error: null });
        found.push({ container, nodes, text, parts, valid: true, output: null, whole: !hasBlocks });
      }
      for (const node of container.childNodes) {
        if (node.nodeType === Node.ELEMENT_NODE && BLOCK.has(node.tagName)) { flush(); visit(node); }
        else if (node.nodeType === Node.ELEMENT_NODE && excluded(node)) { /* never read skipped subtrees */ }
        else if (node.nodeType === Node.ELEMENT_NODE && node.querySelector('p,div,li,td,th,h1,h2,h3,h4,h5,h6,section,article,blockquote,ul,ol')) { flush(); visit(node); }
        else run.push(node);
      }
      flush();
    }
    visit(document.body);
    return found.sort((a, b) => Math.abs(a.container.getBoundingClientRect().top) - Math.abs(b.container.getBoundingClientRect().top));
  }
  function signature(record) { return `${configKey}|${record.text}`; }
  function remember(record) {
    if (!record.valid || record.parts.some(part => part.translation === null)) return;
    let values = cache.get(record.container); if (!values) cache.set(record.container, values = new Map());
    values.set(signature(record), record.parts.map(part => part.translation));
  }
  function stillValid(record) {
    if (location.href !== lastURL) return false;
    for (let ancestor = record.container; ancestor; ancestor = ancestor.parentElement) if (excluded(ancestor)) return false;
    return record.valid && record.container.isConnected && record.nodes.every(node => node.isConnected && node.parentNode === record.container) && normalized(record.nodes.map(read).join('')) === record.text;
  }
  function invalidate(record) {
    record.valid = false; record.output?.remove(); record.output = null;
    cache.get(record.container)?.delete(signature(record));
  }
  function render(record) {
    if (!stillValid(record)) { invalidate(record); return; }
    const text = record.parts.filter(part => part.translation !== null).map(part => part.translation).join('\n');
    if (!text) return;
    if (!record.output) {
      record.output = document.createElement('span'); record.output.setAttribute(OWN, ''); record.output.lang = configKey.split('|')[1] || 'zh-CN';
      record.output.style.cssText = 'display:block!important;margin:0.35em 0 0.65em!important;padding-inline-start:0.65em!important;border-inline-start:2px solid #6b8bce!important;white-space:pre-wrap!important;overflow-wrap:anywhere!important;max-width:100%!important;font-size:0.96em!important;line-height:1.65!important;color:inherit!important;opacity:0.88!important';
      record.nodes.at(-1).after(record.output);
    }
    record.output.textContent = text; remember(record);
  }
  function watch() {
    observer?.disconnect();
    observer = new MutationObserver(mutations => {
      const relevant = mutations.filter(m => {
        if (m.target.nodeType === 1 && m.target.closest(`[${OWN}],#it-translation-root`)) return false;
        if (m.type === 'childList' && [...m.addedNodes, ...m.removedNodes].every(node => node.nodeType === 1 && node.hasAttribute(OWN))) return false;
        return true;
      });
      if (!relevant.length) return;
      for (const record of records) {
        if (!record.valid) continue;
        if (!stillValid(record) || relevant.some(m => record.whole && m.target === record.container && m.type === 'childList')) invalidate(record);
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'style', 'class', 'contenteditable', 'aria-hidden', 'inert', 'open'] });
  }
  function reset(clearCache = false) {
    generation++; observer?.disconnect(); observer = null;
    if (sessionId) void send({ type: 'IT_CANCEL_SESSION', sessionId });
    sessionId = null;
    for (const record of records) record.output?.remove();
    records = []; fatalError = ''; if (clearCache) { cache = new WeakMap(); configKey = ''; }
    state = 'original'; update();
  }
  function batches(pending) {
    const result = []; let batch = [], length = 0;
    for (const item of pending) { if (batch.length >= 8 || length + item.part.text.length > 6000) { result.push(batch); batch = []; length = 0; } batch.push(item); length += item.part.text.length; }
    if (batch.length) result.push(batch); return result;
  }
  async function process(token, retrying = false) {
    const pending = records.filter(record => record.valid).flatMap(record => record.parts.filter(part => part.translation === null && (!retrying || part.error)).map(part => ({ record, part })));
    pending.forEach(({ part }) => { part.error = null; });
    const queue = batches(pending); let cursor = 0; let stopped = false;
    async function worker() {
      while (cursor < queue.length && token === generation && !stopped) {
        const batch = queue[cursor++].filter(({ record }) => stillValid(record));
        if (!batch.length) continue;
        const response = await send({ type: 'IT_TRANSLATE', sessionId, segments: batch.map(({ part }) => ({ id: part.id, text: part.text })) });
        routeCheck();
        if (token !== generation) return;
        if (!response?.ok) {
          const error = response?.error || { message: '翻译失败，请重试。' };
          batch.forEach(({ part }) => { part.error = friendly(error); });
          if (error.fatal) { stopped = true; if (!fatalError || error.code !== 'CANCELLED') fatalError = friendly(error); }
          continue;
        }
        for (const { record, part } of batch) {
          if (!stillValid(record)) { invalidate(record); continue; }
          const translated = response.translations?.filter(item => item.id === part.id);
          if (translated?.length === 1 && typeof translated[0].text === 'string' && translated[0].text.trim()) part.translation = translated[0].text;
          else part.error = friendly(response.failures?.find(item => item.id === part.id)?.error || { message: '服务未返回此段译文，请重试。' });
          render(record);
        }
      }
    }
    await Promise.all([worker(), worker()]);
    if (token !== generation) return;
    const valid = records.filter(record => record.valid), parts = valid.flatMap(record => record.parts);
    const success = parts.filter(part => part.translation !== null).length;
    const failed = parts.filter(part => part.translation === null);
    failed.forEach(part => { part.error ||= fatalError || '该内容未完成翻译，请重试。'; });
    state = failed.length ? (success ? 'partial' : 'error') : 'translated';
    update(failed.length ? (fatalError || (success ? '部分内容未翻译。' : failed[0]?.error || '翻译失败，请重试。')) : (parts.length ? '' : '正文已发生变化，请还原后重新翻译。'));
  }
  async function start() {
    const token = ++generation; state = 'loading'; update();
    // Capture before awaiting the background: later additions belong to the next click.
    records = snapshot('');
    sessionId = (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join(''));
    const response = await send({ type: 'IT_START_SESSION', sessionId });
    routeCheck();
    if (token !== generation) return;
    if (!response?.ok || !response.config?.configured) { state = 'error'; update(response?.ok ? (response.config?.provider === 'libretranslate' ? '请先在设置中填写 LibreTranslate 服务地址。' : '请在设置中选择免费翻译，或配置 AI 服务及 API Key。') : friendly(response?.error)); return; }
    const key = `${response.config.revision}|${response.config.targetLanguage}`;
    if (key !== configKey) { cache = new WeakMap(); configKey = key; }
    records = records.filter(record => !skipLanguage(record.text, response.config.targetLanguage));
    if (!records.length) { state = 'original'; update('未找到可翻译内容。'); return; }
    for (const record of records) {
      const saved = cache.get(record.container)?.get(signature(record));
      if (saved?.length === record.parts.length) record.parts.forEach((part, index) => { part.translation = saved[index]; });
      render(record);
    }
    watch(); await process(token);
  }
  async function safely(action) {
    try { await action(); }
    catch { if (!disposed) { state = records.some(record => record.output) ? 'partial' : 'error'; update('网页翻译未完成，请还原后重试，或刷新网页。'); } }
  }
  button.addEventListener('click', event => {
    if (!event.isTrusted) return;
    if (pickup) return;
    if (ignoreDragClick && event.detail !== 0) { ignoreDragClick = false; return; }
    ignoreDragClick = false; revealPet();
    if (state === 'loading' || state === 'translated' || state === 'partial') reset();
    else { if (state === 'error') reset(); void safely(start); }
  });
  retry.addEventListener('click', event => { if (!event.isTrusted) return; void safely(async () => {
    if (state !== 'partial') return;
    const token = ++generation; state = 'loading'; update(); fatalError = '';
    // A fatal error may have ended the backend session; obtain a fresh one for an explicit retry.
    sessionId = (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join(''));
    const response = await send({ type: 'IT_START_SESSION', sessionId });
    routeCheck();
    if (token !== generation) return;
    if (!response?.ok || !response.config?.configured) { state = 'partial'; update('请检查所选翻译服务后重试。'); return; }
    if (`${response.config.revision}|${response.config.targetLanguage}` !== configKey) { reset(true); return; }
    await process(token, true);
  }); });
  settings.addEventListener('click', event => { if (!event.isTrusted) return; void safely(async () => { const result = await send({ type: 'IT_OPEN_OPTIONS' }); if (!result?.ok) update(friendly(result?.error)); }); });
  chrome.runtime.onMessage.addListener((payload, _sender, respond) => {
    if (payload?.type === 'IT_PAGE_STATUS') { respond({ ok: true, state, supported: true }); return false; }
    if (payload?.type === 'IT_CONFIG_CHANGED') { reset(true); respond?.({ ok: true }); }
    return false;
  });
  function routeCheck() { if (location.href !== lastURL) { lastURL = location.href; reset(true); } }
  let interval = setInterval(() => { if (document.visibilityState === 'visible') routeCheck(); }, 500);
  addEventListener('popstate', routeCheck); addEventListener('hashchange', routeCheck);
  addEventListener('pagehide', () => { disposed = true; cancelPetMotion(); clearInterval(interval); reset(true); });
  addEventListener('pageshow', () => { if (disposed) { disposed = false; lastURL = location.href; interval = setInterval(() => { if (document.visibilityState === 'visible') routeCheck(); }, 500); dockPet(); positionPanel(); armIdle(); } });
  Object.defineProperty(globalThis, '__IT_CONTENT__', { value: Object.freeze({ get state() { return state; } }), configurable: false });
  update();
})();




