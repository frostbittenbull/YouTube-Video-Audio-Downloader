// ==UserScript==
// @name         YouTube — Video & Audio Downloader
// @namespace    http://tampermonkey.net/
// @version      1.0.1
// @updateURL    https://github.com/frostbittenbull/YouTube-Video-Audio-Downloader/raw/refs/heads/main/YouTube-Video-Audio-Downloader.user.js
// @downloadURL  https://github.com/frostbittenbull/YouTube-Video-Audio-Downloader/raw/refs/heads/main/YouTube-Video-Audio-Downloader.user.js
// @description  Добавляет полноценное скачивание видео и аудио на YouTube: достаёт прямые ссылки на медиапоток через несколько клиентов внутреннего API, а если это не удаётся — честно помечает дорожку недоступной (SABR-фолбэк отключён как ненадёжный). Ремукс видео+аудио прямо в браузере через Mediabunny/WebCodecs — без ffmpeg и без бэкенда.
// @author       frostbittenbull
// @icon         https://www.youtube.com/s/desktop/cd0ebe65/img/favicon_32x32.png
// @icon64       https://www.youtube.com/s/desktop/cd0ebe65/img/favicon_32x32.png
// @match        https://www.youtube.com/watch*
// @match        https://www.youtube.com/shorts/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        unsafeWindow
// @connect      cdn.jsdelivr.net
// @connect      www.youtube.com
// @connect      googlevideo.com
// @connect      *.googlevideo.com
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const uw = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  function getCurrentVideoId() {
    try {
      const u = new URL(location.href);
      const v = u.searchParams.get('v');
      if (v) return v;
      const m = u.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{6,})/);
      if (m) return m[1];
    } catch (e) {}
    return null;
  }


  let capturedSabr = null;
  const capturedDirectByItag = new Map();
  let __diagRequestCount = 0;

  window.addEventListener('unhandledrejection', (e) => {
    console.error('[ytdl][diag] unhandledrejection:', e.reason);
  });
  window.addEventListener('error', (e) => {
    console.error('[ytdl][diag] window error:', e.message, e.error);
  });

  function toUint8(body) {
    if (!body) return null;
    if (body instanceof Uint8Array) return body;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return null;
  }

  function maybeCaptureRequest(urlStr, body, method) {
    try {
      if (!urlStr || urlStr.indexOf('googlevideo.com') === -1) return;
      if (urlStr.indexOf('videoplayback') === -1) return;

      __diagRequestCount++;
      console.log(`[ytdl][diag] Замечен запрос плеера #${__diagRequestCount} на googlevideo/videoplayback: method=${method}`, urlStr.slice(0, 140));

      const bytes = toUint8(body);
      if (bytes && bytes.length >= 10) {
        capturedSabr = { url: urlStr, bodyBytes: bytes, capturedAt: Date.now() };
        console.log('[ytdl][diag] это SABR POST (protobuf-тело) — записан как capturedSabr');
        return;
      }

      const u = new URL(urlStr, location.href);
      const itag = u.searchParams.get('itag');
      if (!itag) {
        console.log('[ytdl][diag] В этом запросе нет itag в query — пропуск (не прямой GET по формату)');
        return;
      }
      const mimeRaw = u.searchParams.get('mime') || '';
      const mime = mimeRaw.indexOf('%') !== -1 ? decodeURIComponent(mimeRaw) : mimeRaw;
      u.searchParams.delete('range');
      if (!capturedDirectByItag.has(itag)) {
        console.log('[ytdl][diag] Пойман ПРЯМОЙ GET от самого плеера (не наш спуфинг!), itag=' + itag + ' mime=' + mime);
      }
      capturedDirectByItag.set(itag, { url: u.toString(), mime, itag });
    } catch (e) { }
  }

  async function captureBodyAsync(input, init, urlStr, method) {
    try {
      let req;
      try {
        req = new Request(input, init);
      } catch (e) {
        req = (input && typeof input !== 'string') ? input : null;
      }
      if (!req) return;
      const buf = await req.clone().arrayBuffer();
      if (buf && buf.byteLength > 0) {
        maybeCaptureRequest(urlStr, new Uint8Array(buf), method);
      }
    } catch (e) { }
  }

  const origFetch = uw.fetch;
  if (origFetch && !uw.__ytdlFetchPatched) {
    uw.fetch = function (input, init) {
      try {
        const urlStr = typeof input === 'string' ? input : (input && input.url) || '';
        const method = (init && init.method) || (input && typeof input !== 'string' && input.method) || 'GET';
        let body = init && init.body;
        if (body === undefined && input && typeof input !== 'string' && input.body) body = input.body;
        maybeCaptureRequest(urlStr, body, method);
        if (String(method).toUpperCase() === 'POST' && urlStr.indexOf('videoplayback') !== -1 && !capturedSabr) {
          captureBodyAsync(input, init, urlStr, method);
        }
      } catch (e) {}
      return origFetch.apply(this, arguments);
    };
    uw.__ytdlFetchPatched = true;
  }

  const XHRProto = uw.XMLHttpRequest && uw.XMLHttpRequest.prototype;
  if (XHRProto && !XHRProto.__ytdlPatched) {
    const origOpen = XHRProto.open;
    const origSend = XHRProto.send;
    XHRProto.open = function (method, url) {
      this.__ytdlUrl = url;
      this.__ytdlMethod = method;
      return origOpen.apply(this, arguments);
    };
    XHRProto.send = function (body) {
      try {
        maybeCaptureRequest(this.__ytdlUrl, body, this.__ytdlMethod);
        if (body && typeof body.arrayBuffer === 'function' && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) {
          const url = this.__ytdlUrl, method = this.__ytdlMethod;
          body.arrayBuffer().then((buf) => {
            if (buf && buf.byteLength > 0) maybeCaptureRequest(url, new Uint8Array(buf), method);
          }).catch(() => {});
        }
      } catch (e) {}
      return origSend.apply(this, arguments);
    };
    XHRProto.__ytdlPatched = true;
  }

  if (uw.Worker && !uw.__ytdlWorkerPatched) {
    const OrigWorker = uw.Worker;
    function PatchedWorker(scriptURL, options) {
      try { console.log('[ytdl][diag] new Worker:', String(scriptURL).slice(0, 160)); } catch (e) {}
      return new OrigWorker(scriptURL, options);
    }
    PatchedWorker.prototype = OrigWorker.prototype;
    try { uw.Worker = PatchedWorker; uw.__ytdlWorkerPatched = true; } catch (e) {}
  }

  const GOOGLEVIDEO_BUNDLE_SRC = "var GoogleVideoBundle=(()=>{var Ee=Object.defineProperty;var gt=Object.getOwnPropertyDescriptor;var Ut=Object.getOwnPropertyNames;var wt=Object.prototype.hasOwnProperty;var B=(e,n)=>{for(var t in n)Ee(e,t,{get:n[t],enumerable:!0})},Ft=(e,n,t,r)=>{if(n&&typeof n==\"object\"||typeof n==\"function\")for(let o of Ut(n))!wt.call(e,o)&&o!==t&&Ee(e,o,{get:()=>n[o],enumerable:!(r=gt(n,o))||r.enumerable});return e};var vt=e=>Ft(Ee({},\"__esModule\",{value:!0}),e);var fi={};B(fi,{Protos:()=>De,SabrStreamMod:()=>Le,UMP:()=>we,Utils:()=>ge});var Le={};B(Le,{SabrStream:()=>Be});function ve(){let e=0,n=0;for(let r=0;r<28;r+=7){let o=this.buf[this.pos++];if(e|=(o&127)<<r,(o&128)==0)return this.assertBounds(),[e,n]}let t=this.buf[this.pos++];if(e|=(t&15)<<28,n=(t&112)>>4,(t&128)==0)return this.assertBounds(),[e,n];for(let r=3;r<=31;r+=7){let o=this.buf[this.pos++];if(n|=(o&127)<<r,(o&128)==0)return this.assertBounds(),[e,n]}throw new Error(\"invalid varint\")}function Y(e,n,t){for(let i=0;i<28;i=i+7){let d=e>>>i,c=!(!(d>>>7)&&n==0),u=(c?d|128:d)&255;if(t.push(u),!c)return}let r=e>>>28&15|(n&7)<<4,o=n>>3!=0;if(t.push((o?r|128:r)&255),!!o){for(let i=3;i<31;i=i+7){let d=n>>>i,c=!!(d>>>7),u=(c?d|128:d)&255;if(t.push(u),!c)return}t.push(n>>>31&1)}}var G=4294967296;function be(e){let n=e[0]===\"-\";n&&(e=e.slice(1));let t=1e6,r=0,o=0;function i(d,c){let u=Number(e.slice(d,c));o*=t,r=r*t+u,r>=G&&(o=o+(r/G|0),r=r%G)}return i(-24,-18),i(-18,-12),i(-12,-6),i(-6),n?Ke(r,o):Se(r,o)}function He(e,n){let t=Se(e,n),r=t.hi&2147483648;r&&(t=Ke(t.lo,t.hi));let o=_e(t.lo,t.hi);return r?\"-\"+o:o}function _e(e,n){if({lo:e,hi:n}=Ht(e,n),n<=2097151)return String(G*n+e);let t=e&16777215,r=(e>>>24|n<<8)&16777215,o=n>>16&65535,i=t+r*6777216+o*6710656,d=r+o*8147497,c=o*2,u=1e7;return i>=u&&(d+=Math.floor(i/u),i%=u),d>=u&&(c+=Math.floor(d/u),d%=u),c.toString()+Fe(d)+Fe(i)}function Ht(e,n){return{lo:e>>>0,hi:n>>>0}}function Se(e,n){return{lo:e|0,hi:n|0}}function Ke(e,n){return n=~n,e?e=~e+1:n+=1,Se(e,n)}var Fe=e=>{let n=String(e);return\"0000000\".slice(n.length)+n};function Re(e,n){if(e>=0){for(;e>127;)n.push(e&127|128),e=e>>>7;n.push(e)}else{for(let t=0;t<9;t++)n.push(e&127|128),e=e>>7;n.push(1)}}function Ve(){let e=this.buf[this.pos++],n=e&127;if((e&128)==0)return this.assertBounds(),n;if(e=this.buf[this.pos++],n|=(e&127)<<7,(e&128)==0)return this.assertBounds(),n;if(e=this.buf[this.pos++],n|=(e&127)<<14,(e&128)==0)return this.assertBounds(),n;if(e=this.buf[this.pos++],n|=(e&127)<<21,(e&128)==0)return this.assertBounds(),n;e=this.buf[this.pos++],n|=(e&15)<<28;for(let t=5;(e&128)!==0&&t<10;t++)e=this.buf[this.pos++];if((e&128)!=0)throw new Error(\"invalid varint\");return this.assertBounds(),n>>>0}var b=Kt();function Kt(){let e=new DataView(new ArrayBuffer(8));if(typeof BigInt==\"function\"&&typeof e.getBigInt64==\"function\"&&typeof e.getBigUint64==\"function\"&&typeof e.setBigInt64==\"function\"&&typeof e.setBigUint64==\"function\"&&(!!globalThis.Deno||!!globalThis.Bun||typeof process!=\"object\"||typeof process.env!=\"object\"||process.env.BUF_BIGINT_DISABLE!==\"1\")){let t=BigInt(\"-9223372036854775808\"),r=BigInt(\"9223372036854775807\"),o=BigInt(\"0\"),i=BigInt(\"18446744073709551615\");return{zero:BigInt(0),supported:!0,parse(d){let c=typeof d==\"bigint\"?d:BigInt(d);if(c>r||c<t)throw new Error(`invalid int64: ${d}`);return c},uParse(d){let c=typeof d==\"bigint\"?d:BigInt(d);if(c>i||c<o)throw new Error(`invalid uint64: ${d}`);return c},enc(d){return e.setBigInt64(0,this.parse(d),!0),{lo:e.getInt32(0,!0),hi:e.getInt32(4,!0)}},uEnc(d){return e.setBigInt64(0,this.uParse(d),!0),{lo:e.getInt32(0,!0),hi:e.getInt32(4,!0)}},dec(d,c){return e.setInt32(0,d,!0),e.setInt32(4,c,!0),e.getBigInt64(0,!0)},uDec(d,c){return e.setInt32(0,d,!0),e.setInt32(4,c,!0),e.getBigUint64(0,!0)}}}return{zero:\"0\",supported:!1,parse(t){return typeof t!=\"string\"&&(t=t.toString()),We(t),t},uParse(t){return typeof t!=\"string\"&&(t=t.toString()),Ge(t),t},enc(t){return typeof t!=\"string\"&&(t=t.toString()),We(t),be(t)},uEnc(t){return typeof t!=\"string\"&&(t=t.toString()),Ge(t),be(t)},dec(t,r){return He(t,r)},uDec(t,r){return _e(t,r)}}}function We(e){if(!/^-?[0-9]+$/.test(e))throw new Error(\"invalid int64: \"+e)}function Ge(e){if(!/^[0-9]+$/.test(e))throw new Error(\"invalid uint64: \"+e)}var Ie=Symbol.for(\"@bufbuild/protobuf/text-encoding\");function ke(){if(globalThis[Ie]==null){let e=new globalThis.TextEncoder,n=new globalThis.TextDecoder,t;globalThis[Ie]={encodeUtf8(r){return e.encode(r)},decodeUtf8(r,o){return o?(t===void 0&&(t=new globalThis.TextDecoder(\"utf-8\",{fatal:!0})),t.decode(r)):n.decode(r)},checkUtf8(r){try{return encodeURIComponent(r),!0}catch{return!1}}}}return globalThis[Ie]}var y;(function(e){e[e.Varint=0]=\"Varint\",e[e.Bit64=1]=\"Bit64\",e[e.LengthDelimited=2]=\"LengthDelimited\",e[e.StartGroup=3]=\"StartGroup\",e[e.EndGroup=4]=\"EndGroup\",e[e.Bit32=5]=\"Bit32\"})(y||(y={}));var Vt=34028234663852886e22,Wt=-34028234663852886e22,Gt=4294967295,Yt=2147483647,qt=-2147483648,s=class{constructor(n=ke().encodeUtf8){this.encodeUtf8=n,this.stack=[],this.chunks=[],this.buf=[]}finish(){this.buf.length&&(this.chunks.push(new Uint8Array(this.buf)),this.buf=[]);let n=0;for(let o=0;o<this.chunks.length;o++)n+=this.chunks[o].length;let t=new Uint8Array(n),r=0;for(let o=0;o<this.chunks.length;o++)t.set(this.chunks[o],r),r+=this.chunks[o].length;return this.chunks=[],t}fork(){return this.stack.push({chunks:this.chunks,buf:this.buf}),this.chunks=[],this.buf=[],this}join(){let n=this.finish(),t=this.stack.pop();if(!t)throw new Error(\"invalid state, fork stack empty\");return this.chunks=t.chunks,this.buf=t.buf,this.uint32(n.byteLength),this.raw(n)}tag(n,t){return this.uint32((n<<3|t)>>>0)}raw(n){return this.buf.length&&(this.chunks.push(new Uint8Array(this.buf)),this.buf=[]),this.chunks.push(n),this}uint32(n){for(Ye(n);n>127;)this.buf.push(n&127|128),n=n>>>7;return this.buf.push(n),this}int32(n){return Te(n),Re(n,this.buf),this}bool(n){return this.buf.push(n?1:0),this}bytes(n){return this.uint32(n.byteLength),this.raw(n)}string(n){let t=this.encodeUtf8(n);return this.uint32(t.byteLength),this.raw(t)}float(n){zt(n);let t=new Uint8Array(4);return new DataView(t.buffer).setFloat32(0,n,!0),this.raw(t)}double(n){let t=new Uint8Array(8);return new DataView(t.buffer).setFloat64(0,n,!0),this.raw(t)}fixed32(n){Ye(n);let t=new Uint8Array(4);return new DataView(t.buffer).setUint32(0,n,!0),this.raw(t)}sfixed32(n){Te(n);let t=new Uint8Array(4);return new DataView(t.buffer).setInt32(0,n,!0),this.raw(t)}sint32(n){return Te(n),n=(n<<1^n>>31)>>>0,Re(n,this.buf),this}sfixed64(n){let t=new Uint8Array(8),r=new DataView(t.buffer),o=b.enc(n);return r.setInt32(0,o.lo,!0),r.setInt32(4,o.hi,!0),this.raw(t)}fixed64(n){let t=new Uint8Array(8),r=new DataView(t.buffer),o=b.uEnc(n);return r.setInt32(0,o.lo,!0),r.setInt32(4,o.hi,!0),this.raw(t)}int64(n){let t=b.enc(n);return Y(t.lo,t.hi,this.buf),this}sint64(n){let t=b.enc(n),r=t.hi>>31,o=t.lo<<1^r,i=(t.hi<<1|t.lo>>>31)^r;return Y(o,i,this.buf),this}uint64(n){let t=b.uEnc(n);return Y(t.lo,t.hi,this.buf),this}},a=class{constructor(n,t=ke().decodeUtf8){this.decodeUtf8=t,this.varint64=ve,this.uint32=Ve,this.buf=n,this.len=n.length,this.pos=0,this.view=new DataView(n.buffer,n.byteOffset,n.byteLength)}tag(){let n=this.pos,t=this.uint32(),r=this.pos-n;if(r>5||r==5&&this.buf[this.pos-1]>15)throw new Error(\"illegal tag: varint overflows uint32\");let o=t>>>3,i=t&7;if(o<=0||i>5)throw new Error(\"illegal tag: field no \"+o+\" wire type \"+i);return[o,i]}skip(n,t,r=100){let o=this.pos;switch(n){case y.Varint:for(;this.buf[this.pos++]&128;);break;case y.Bit64:this.pos+=4;case y.Bit32:this.pos+=4;break;case y.LengthDelimited:let i=this.uint32();this.pos+=i;break;case y.StartGroup:if(r<=0)throw new Error(\"maximum recursion depth reached\");for(;;){let[d,c]=this.tag();if(c===y.EndGroup){if(t!==void 0&&d!==t)throw new Error(\"invalid end group tag\");break}this.skip(c,d,r-1)}break;default:throw new Error(\"cant skip wire type \"+n)}return this.assertBounds(),this.buf.subarray(o,this.pos)}assertBounds(){if(this.pos>this.len)throw new RangeError(\"premature EOF\")}int32(){return this.uint32()|0}sint32(){let n=this.uint32();return n>>>1^-(n&1)}int64(){return b.dec(...this.varint64())}uint64(){return b.uDec(...this.varint64())}sint64(){let[n,t]=this.varint64(),r=-(n&1);return n=(n>>>1|(t&1)<<31)^r,t=t>>>1^r,b.dec(n,t)}bool(){let[n,t]=this.varint64();return n!==0||t!==0}fixed32(){return this.view.getUint32((this.pos+=4)-4,!0)}sfixed32(){return this.view.getInt32((this.pos+=4)-4,!0)}fixed64(){return b.uDec(this.sfixed32(),this.sfixed32())}sfixed64(){return b.dec(this.sfixed32(),this.sfixed32())}float(){return this.view.getFloat32((this.pos+=4)-4,!0)}double(){return this.view.getFloat64((this.pos+=8)-8,!0)}bytes(){let n=this.uint32(),t=this.pos;return this.pos+=n,this.assertBounds(),this.buf.subarray(t,t+n)}string(n){return this.decodeUtf8(this.bytes(),n)}};function Te(e){if(typeof e==\"string\")e=Number(e);else if(typeof e!=\"number\")throw new Error(\"invalid int32: \"+typeof e);if(!Number.isInteger(e)||e>Yt||e<qt)throw new Error(\"invalid int32: \"+e)}function Ye(e){if(typeof e==\"string\")e=Number(e);else if(typeof e!=\"number\")throw new Error(\"invalid uint32: \"+typeof e);if(!Number.isInteger(e)||e>Gt||e<0)throw new Error(\"invalid uint32: \"+e)}function zt(e){if(typeof e==\"string\"){let n=e;if(e=Number(e),Number.isNaN(e)&&n!==\"NaN\")throw new Error(\"invalid float32: \"+n)}else if(typeof e!=\"number\")throw new Error(\"invalid float32: \"+typeof e);if(Number.isFinite(e)&&(e>Vt||e<Wt))throw new Error(\"invalid float32: \"+e)}var qe={UNKNOWN:0,0:\"UNKNOWN\",GZIP:1,1:\"GZIP\",BROTLI:2,2:\"BROTLI\",UNRECOGNIZED:-1,\"-1\":\"UNRECOGNIZED\"},ze={UNKNOWN:0,0:\"UNKNOWN\",ULTRALOW:5,5:\"ULTRALOW\",LOW:10,10:\"LOW\",MEDIUM:20,20:\"MEDIUM\",HIGH:30,30:\"HIGH\",UNRECOGNIZED:-1,\"-1\":\"UNRECOGNIZED\"},$e={UNKNOWN:0,0:\"UNKNOWN\",HIGHER_QUALITY:1,1:\"HIGHER_QUALITY\",DATA_SAVER:2,2:\"DATA_SAVER\",ADVANCED_MENU:3,3:\"ADVANCED_MENU\",UNRECOGNIZED:-1,\"-1\":\"UNRECOGNIZED\"},je={UNKNOWN:0,0:\"UNKNOWN\",LINE_OUT:1,1:\"LINE_OUT\",HEADPHONES:2,2:\"HEADPHONES\",BLUETOOTH_A2DP:3,3:\"BLUETOOTH_A2DP\",BUILT_IN_RECEIVER:4,4:\"BUILT_IN_RECEIVER\",BUILT_IN_SPEAKER:5,5:\"BUILT_IN_SPEAKER\",HDMI:6,6:\"HDMI\",AIR_PLAY:7,7:\"AIR_PLAY\",BLUETOOTH_LE:8,8:\"BLUETOOTH_LE\",BLUETOOTH_HFP:9,9:\"BLUETOOTH_HFP\",USB_AUDIO:10,10:\"USB_AUDIO\",CAR_PLAY:11,11:\"CAR_PLAY\",ANDROID_AUDIO:12,12:\"ANDROID_AUDIO\",UNRECOGNIZED:-1,\"-1\":\"UNRECOGNIZED\"},Qe={UNKNOWN:0,0:\"UNKNOWN\",UNMETERED:1,1:\"UNMETERED\",METERED:2,2:\"METERED\",UNRECOGNIZED:-1,\"-1\":\"UNRECOGNIZED\"},Xe={UNKNOWN:0,0:\"UNKNOWN\",TIMESTAMP_IN_COMMENTS:1,1:\"TIMESTAMP_IN_COMMENTS\",TIMESTAMP_IN_DESCRIPTION:2,2:\"TIMESTAMP_IN_DESCRIPTION\",MACRO_MARKER_LIST_ITEM:3,3:\"MACRO_MARKER_LIST_ITEM\",DOUBLE_TAP_TO_SEEK:4,4:\"DOUBLE_TAP_TO_SEEK\",DOUBLE_TAP_TO_SKIP_CHAPTER:5,5:\"DOUBLE_TAP_TO_SKIP_CHAPTER\",PICK_UP_PLAY_HEAD:6,6:\"PICK_UP_PLAY_HEAD\",SLIDE_ON_SCRUBBER_BAR:7,7:\"SLIDE_ON_SCRUBBER_BAR\",SLIDE_ON_PLAYER:8,8:\"SLIDE_ON_PLAYER\",SABR_PARTIAL_CHUNK:9,9:\"SABR_PARTIAL_CHUNK\",SABR_SEEK_TO_HEAD:10,10:\"SABR_SEEK_TO_HEAD\",SABR_LIVE_DVR_USER_SEEK:11,11:\"SABR_LIVE_DVR_USER_SEEK\",SABR_SEEK_TO_DVR_LOWER_BOUND:12,12:\"SABR_SEEK_TO_DVR_LOWER_BOUND\",SABR_SEEK_TO_DVR_UPPER_BOUND:13,13:\"SABR_SEEK_TO_DVR_UPPER_BOUND\",SSDAI_INTERNAL:14,14:\"SSDAI_INTERNAL\",START_PLAYBACK:15,15:\"START_PLAYBACK\",SABR_ACCURATE_SEEK:17,17:\"SABR_ACCURATE_SEEK\",START_PLAYBACK_SEEK_TO_END:18,18:\"START_PLAYBACK_SEEK_TO_END\",IOS_PLAYER_REMOVED_SEGMENTS:19,19:\"IOS_PLAYER_REMOVED_SEGMENTS\",IOS_PLAYER_SEGMENT_LIST:20,20:\"IOS_PLAYER_SEGMENT_LIST\",IOS_PLAYER_ITEM_SEEK:21,21:\"IOS_PLAYER_ITEM_SEEK\",IOS_PLAYER_ITEM_SEEK_TO_END:22,22:\"IOS_PLAYER_ITEM_SEEK_TO_END\",IOS_PLAYER_SEEK_TO_END_TO_RESYNC:23,23:\"IOS_PLAYER_SEEK_TO_END_TO_RESYNC\",IOS_SEEK_ACCESSIBILITY_BUTTON:24,24:\"IOS_SEEK_ACCESSIBILITY_BUTTON\",FINE_SCRUBBER_SLIDE_ON_FILMSTRIP:25,25:\"FINE_SCRUBBER_SLIDE_ON_FILMSTRIP\",FINE_SCRUBBER_TAP_ON_FILMSTRIP:26,26:\"FINE_SCRUBBER_TAP_ON_FILMSTRIP\",FINE_SCRUBBER_SLIDE_ON_SCRUBBER_BAR:27,27:\"FINE_SCRUBBER_SLIDE_ON_SCRUBBER_BAR\",SEEK_BUTTON_ON_PLAYER_CONTROL:28,28:\"SEEK_BUTTON_ON_PLAYER_CONTROL\",SABR_INGESTION_WALL_TIME_SEEK:29,29:\"SABR_INGESTION_WALL_TIME_SEEK\",PLAYER_VIEW_REPARENT_INTERNAL:30,30:\"PLAYER_VIEW_REPARENT_INTERNAL\",PRESS_REWIND_PLAY_BACK_CONTROL:31,31:\"PRESS_REWIND_PLAY_BACK_CONTROL\",PRESS_FAST_FORWARD_PLAY_BACK_CONTROL:32,32:\"PRESS_FAST_FORWARD_PLAY_BACK_CONTROL\",PRESS_LIVE_SYNC_ICON:33,33:\"PRESS_LIVE_SYNC_ICON\",PEG_TO_LIVE:34,34:\"PEG_TO_LIVE\",ANDROID_MEDIA_SESSION:35,35:\"ANDROID_MEDIA_SESSION\",TAP_ON_REPLAY_ACTION:36,36:\"TAP_ON_REPLAY_ACTION\",AUTOMATIC_REPLAY_ACTION:37,37:\"AUTOMATIC_REPLAY_ACTION\",NON_USER_SEEK_TO_PREVIOUS:38,38:\"NON_USER_SEEK_TO_PREVIOUS\",NON_USER_SEEK_TO_NEXT:39,39:\"NON_USER_SEEK_TO_NEXT\",HIGHLIGHTS_TAP_PREVIOUS_PLAY:66,66:\"HIGHLIGHTS_TAP_PREVIOUS_PLAY\",HIGHLIGHTS_TAP_NEXT_PLAY:40,40:\"HIGHLIGHTS_TAP_NEXT_PLAY\",HIGHLIGHTS_TAP_HIDDEN_NEXT_PLAY:41,41:\"HIGHLIGHTS_TAP_HIDDEN_NEXT_PLAY\",HIGHLIGHTS_TAP_LIST_ITEM:42,42:\"HIGHLIGHTS_TAP_LIST_ITEM\",HIGHLIGHTS_AUTOMATIC_NEXT_PLAY:43,43:\"HIGHLIGHTS_AUTOMATIC_NEXT_PLAY\",HIGHLIGHTS_SEEK_TO_FIRST_PLAY:44,44:\"HIGHLIGHTS_SEEK_TO_FIRST_PLAY\",HIGHLIGHTS_SEEK_TO_END:45,45:\"HIGHLIGHTS_SEEK_TO_END\",SEGMENTS_TAP_LIST_ITEM:46,46:\"SEGMENTS_TAP_LIST_ITEM\",PIP_FAST_FORWARD_BUTTON:47,47:\"PIP_FAST_FORWARD_BUTTON\",PIP_REWIND_BUTTON:48,48:\"PIP_REWIND_BUTTON\",PIP_RESUME_ON_HEAD:49,49:\"PIP_RESUME_ON_HEAD\",MOVING_CLIP_FRAME:50,50:\"MOVING_CLIP_FRAME\",RESUME_CLIP_PREVIOUS_POSITION:51,51:\"RESUME_CLIP_PREVIOUS_POSITION\",SEEK_TO_NEXT_CHAPTER:52,52:\"SEEK_TO_NEXT_CHAPTER\",SEEK_TO_PREVIOUS_CHAPTER:53,53:\"SEEK_TO_PREVIOUS_CHAPTER\",IOS_SHAREPLAY_PAUSE:54,54:\"IOS_SHAREPLAY_PAUSE\",IOS_SHAREPLAY_SEEK:55,55:\"IOS_SHAREPLAY_SEEK\",IOS_SHAREPLAY_SYNC_RESPONSE:56,56:\"IOS_SHAREPLAY_SYNC_RESPONSE\",SEEK_TO_HEAD_IMMERSIVE_LIVE_VIDEO:57,57:\"SEEK_TO_HEAD_IMMERSIVE_LIVE_VIDEO\",SEEK_TO_START_OF_LOOPING_RANGE_OF_SHORTS:58,58:\"SEEK_TO_START_OF_LOOPING_RANGE_OF_SHORTS\",SABR_SEEK_TO_CLOSEST_KEYFRAME:59,59:\"SABR_SEEK_TO_CLOSEST_KEYFRAME\",SEEK_TO_END_OF_LOOPING_RANGE_OF_SHORTS:60,60:\"SEEK_TO_END_OF_LOOPING_RANGE_OF_SHORTS\",CLIP_SLIDE_ON_FLIMSTRIP:61,61:\"CLIP_SLIDE_ON_FLIMSTRIP\",PICK_UP_CLIP_SLIDER:62,62:\"PICK_UP_CLIP_SLIDER\",FINE_SCRUBBER_CANCELLED:63,63:\"FINE_SCRUBBER_CANCELLED\",INLINE_PLAYER_SEEK_CHAPTER:64,64:\"INLINE_PLAYER_SEEK_CHAPTER\",INLINE_PLAYER_SEEK_SECONDS:65,65:\"INLINE_PLAYER_SEEK_SECONDS\",HIGHLIGHTS_PLAYER_EXIT_FULLSCREEN:67,67:\"HIGHLIGHTS_PLAYER_EXIT_FULLSCREEN\",LARGE_CONTROLS_FORWARD_BUTTON:68,68:\"LARGE_CONTROLS_FORWARD_BUTTON\",LARGE_CONTROLS_REWIND_BUTTON:69,69:\"LARGE_CONTROLS_REWIND_BUTTON\",LARGE_CONTROLS_SCRUBBER_BAR:70,70:\"LARGE_CONTROLS_SCRUBBER_BAR\",SEEK_BACKWARD_5S:71,71:\"SEEK_BACKWARD_5S\",SEEK_FORWARD_5S:72,72:\"SEEK_FORWARD_5S\",SEEK_BACKWARD_10S:73,73:\"SEEK_BACKWARD_10S\",SEEK_FORWARD_10S:74,74:\"SEEK_FORWARD_10S\",SEEK_FORWARD_60S:75,75:\"SEEK_FORWARD_60S\",SEEK_BACKWARD_60S:76,76:\"SEEK_BACKWARD_60S\",SEEK_TO_NEXT_FRAME:77,77:\"SEEK_TO_NEXT_FRAME\",SEEK_TO_PREV_FRAME:78,78:\"SEEK_TO_PREV_FRAME\",KEYBOARD_SEEK_TO_BEGINNING:79,79:\"KEYBOARD_SEEK_TO_BEGINNING\",KEYBOARD_SEEK_TO_END:80,80:\"KEYBOARD_SEEK_TO_END\",SEEK_PERCENT_OF_VIDEO:81,81:\"SEEK_PERCENT_OF_VIDEO\",HIDDEN_FAST_FORWARD_BUTTON:82,82:\"HIDDEN_FAST_FORWARD_BUTTON\",HIDDEN_REWIND_BUTTON:83,83:\"HIDDEN_REWIND_BUTTON\",TIMESTAMP:84,84:\"TIMESTAMP\",LR_MEDIA_SESSION_SEEK:87,87:\"LR_MEDIA_SESSION_SEEK\",MIDROLLS_WITH_TIME_RANGE:88,88:\"MIDROLLS_WITH_TIME_RANGE\",SKIP_AD:89,89:\"SKIP_AD\",SEEK_TO_PREVIOUS:90,90:\"SEEK_TO_PREVIOUS\",SEEK_TO_NEXT:91,91:\"SEEK_TO_NEXT\",LR_QUICK_SEEK:92,92:\"LR_QUICK_SEEK\",ONESIE_LIVE:93,93:\"ONESIE_LIVE\",LR_PLAYER_CONTROL_ACTION:94,94:\"LR_PLAYER_CONTROL_ACTION\",UNPLUGGED_LENS_START_CLIP:95,95:\"UNPLUGGED_LENS_START_CLIP\",LR_KEY_PLAYS:96,96:\"LR_KEY_PLAYS\",SSAP_AD_FMT_FATAL:97,97:\"SSAP_AD_FMT_FATAL\",TVHTML5_INPUT_SOURCE_KEY_EVENT:98,98:\"TVHTML5_INPUT_SOURCE_KEY_EVENT\",TVHTML5_INPUT_SOURCE_CONTROLS:99,99:\"TVHTML5_INPUT_SOURCE_CONTROLS\",TVHTML5_INPUT_SOURCE_TOUCH:100,100:\"TVHTML5_INPUT_SOURCE_TOUCH\",TVHTML5_INPUT_SOURCE_TOUCHPAD:101,101:\"TVHTML5_INPUT_SOURCE_TOUCHPAD\",SEEK_TO_HEAD:102,102:\"SEEK_TO_HEAD\",AUTOMATIC_PREVIEW_REPLAY_ACTION:103,103:\"AUTOMATIC_PREVIEW_REPLAY_ACTION\",H5_MEDIA_ELEMENT_EVENT:104,104:\"H5_MEDIA_ELEMENT_EVENT\",H5_WORKAROUND_SEEK:105,105:\"H5_WORKAROUND_SEEK\",MINIPLAYER_REWIND_BUTTON:106,106:\"MINIPLAYER_REWIND_BUTTON\",MINIPLAYER_FAST_FORWARD_BUTTON:107,107:\"MINIPLAYER_FAST_FORWARD_BUTTON\",SABR_RELOAD_PLAYER_RESPONSE_TOKEN_SEEK:108,108:\"SABR_RELOAD_PLAYER_RESPONSE_TOKEN_SEEK\",SLIDE_ON_SCRUBBER_BAR_CHAPTER:109,109:\"SLIDE_ON_SCRUBBER_BAR_CHAPTER\",ANDROID_CLEAR_BUFFER:110,110:\"ANDROID_CLEAR_BUFFER\",UNRECOGNIZED:-1,\"-1\":\"UNRECOGNIZED\"},Ze={UNKNOWN:0,0:\"UNKNOWN\",ENCRYPTED_PLAYER_SERVICE:1,1:\"ENCRYPTED_PLAYER_SERVICE\",ENCRYPTED_WATCH_SERVICE_DEPRECATED:2,2:\"ENCRYPTED_WATCH_SERVICE_DEPRECATED\",ENCRYPTED_WATCH_SERVICE:3,3:\"ENCRYPTED_WATCH_SERVICE\",INNERTUBE_ENCRYPTED_SERVICE:4,4:\"INNERTUBE_ENCRYPTED_SERVICE\",UNRECOGNIZED:-1,\"-1\":\"UNRECOGNIZED\"};function $t(){return{name:\"\",value:\"\"}}var N={encode(e,n=new s){return e.name!==void 0&&e.name!==\"\"&&n.uint32(10).string(e.name),e.value!==void 0&&e.value!==\"\"&&n.uint32(18).string(e.value),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=$t();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==10)break;o.name=t.string();continue}case 2:{if(i!==18)break;o.value=t.string();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function jt(){return{itag:0,lastModified:\"0\",xtags:\"\"}}var l={encode(e,n=new s){return e.itag!==void 0&&e.itag!==0&&n.uint32(8).int32(e.itag),e.lastModified!==void 0&&e.lastModified!==\"0\"&&n.uint32(16).uint64(e.lastModified),e.xtags!==void 0&&e.xtags!==\"\"&&n.uint32(26).string(e.xtags),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=jt();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==8)break;o.itag=t.int32();continue}case 2:{if(i!==16)break;o.lastModified=t.uint64().toString();continue}case 3:{if(i!==26)break;o.xtags=t.string();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function Qt(){return{legacyStart:0,legacyEnd:0,start:0,end:0}}var m={encode(e,n=new s){return e.legacyStart!==void 0&&e.legacyStart!==0&&n.uint32(8).int32(e.legacyStart),e.legacyEnd!==void 0&&e.legacyEnd!==0&&n.uint32(16).int32(e.legacyEnd),e.start!==void 0&&e.start!==0&&n.uint32(24).int32(e.start),e.end!==void 0&&e.end!==0&&n.uint32(32).int32(e.end),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=Qt();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==8)break;o.legacyStart=t.int32();continue}case 2:{if(i!==16)break;o.legacyEnd=t.int32();continue}case 3:{if(i!==24)break;o.start=t.int32();continue}case 4:{if(i!==32)break;o.end=t.int32();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function Xt(){return{requestNumber:0,field5:0}}var Je={encode(e,n=new s){return e.requestNumber!==void 0&&e.requestNumber!==0&&n.uint32(8).int32(e.requestNumber),e.field5!==void 0&&e.field5!==0&&n.uint32(40).int32(e.field5),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=Xt();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==8)break;o.requestNumber=t.int32();continue}case 5:{if(i!==40)break;o.field5=t.int32();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function Zt(){return{key:\"\",value:\"\"}}var et={encode(e,n=new s){return e.key!==void 0&&e.key!==\"\"&&n.uint32(10).string(e.key),e.value!==void 0&&e.value!==\"\"&&n.uint32(18).string(e.value),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=Zt();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==10)break;o.key=t.string();continue}case 2:{if(i!==18)break;o.value=t.string();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function Jt(){return{trackType:0,isHdr:!1}}var q={encode(e,n=new s){return e.trackType!==void 0&&e.trackType!==0&&n.uint32(8).int32(e.trackType),e.isHdr!==void 0&&e.isHdr!==!1&&n.uint32(16).bool(e.isHdr),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=Jt();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==8)break;o.trackType=t.int32();continue}case 2:{if(i!==16)break;o.isHdr=t.bool();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function en(){return{authorizedFormats:[],sabrLicenseConstraint:new Uint8Array(0)}}var g={encode(e,n=new s){for(let t of e.authorizedFormats)q.encode(t,n.uint32(10).fork()).join();return e.sabrLicenseConstraint!==void 0&&e.sabrLicenseConstraint.length!==0&&n.uint32(18).bytes(e.sabrLicenseConstraint),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=en();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==10)break;o.authorizedFormats.push(q.decode(t,t.uint32()));continue}case 2:{if(i!==18)break;o.sabrLicenseConstraint=t.bytes();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function tn(){return{videoId:\"\",formatId:void 0,endTimeMs:\"0\",endSegmentNumber:\"0\",mimeType:\"\",initRange:void 0,indexRange:void 0,field8:\"0\",durationUnits:\"0\",durationTimescale:\"0\"}}var z={encode(e,n=new s){return e.videoId!==void 0&&e.videoId!==\"\"&&n.uint32(10).string(e.videoId),e.formatId!==void 0&&l.encode(e.formatId,n.uint32(18).fork()).join(),e.endTimeMs!==void 0&&e.endTimeMs!==\"0\"&&n.uint32(24).int64(e.endTimeMs),e.endSegmentNumber!==void 0&&e.endSegmentNumber!==\"0\"&&n.uint32(32).int64(e.endSegmentNumber),e.mimeType!==void 0&&e.mimeType!==\"\"&&n.uint32(42).string(e.mimeType),e.initRange!==void 0&&m.encode(e.initRange,n.uint32(50).fork()).join(),e.indexRange!==void 0&&m.encode(e.indexRange,n.uint32(58).fork()).join(),e.field8!==void 0&&e.field8!==\"0\"&&n.uint32(64).int64(e.field8),e.durationUnits!==void 0&&e.durationUnits!==\"0\"&&n.uint32(72).int64(e.durationUnits),e.durationTimescale!==void 0&&e.durationTimescale!==\"0\"&&n.uint32(80).int64(e.durationTimescale),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=tn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==10)break;o.videoId=t.string();continue}case 2:{if(i!==18)break;o.formatId=l.decode(t,t.uint32());continue}case 3:{if(i!==24)break;o.endTimeMs=t.int64().toString();continue}case 4:{if(i!==32)break;o.endSegmentNumber=t.int64().toString();continue}case 5:{if(i!==42)break;o.mimeType=t.string();continue}case 6:{if(i!==50)break;o.initRange=m.decode(t,t.uint32());continue}case 7:{if(i!==58)break;o.indexRange=m.decode(t,t.uint32());continue}case 8:{if(i!==64)break;o.field8=t.int64().toString();continue}case 9:{if(i!==72)break;o.durationUnits=t.int64().toString();continue}case 10:{if(i!==80)break;o.durationTimescale=t.int64().toString();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function nn(){return{startTicks:\"0\",durationTicks:\"0\",timescale:0}}var T={encode(e,n=new s){return e.startTicks!==void 0&&e.startTicks!==\"0\"&&n.uint32(8).int64(e.startTicks),e.durationTicks!==void 0&&e.durationTicks!==\"0\"&&n.uint32(16).int64(e.durationTicks),e.timescale!==void 0&&e.timescale!==0&&n.uint32(24).int32(e.timescale),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=nn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==8)break;o.startTicks=t.int64().toString();continue}case 2:{if(i!==16)break;o.durationTicks=t.int64().toString();continue}case 3:{if(i!==24)break;o.timescale=t.int32();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function on(){return{headerId:0,videoId:\"\",itag:0,lmt:\"0\",xtags:\"\",startRange:\"0\",compressionAlgorithm:0,isInitSeg:!1,sequenceNumber:0,bitrateBps:\"0\",startMs:\"0\",durationMs:\"0\",formatId:void 0,contentLength:\"0\",timeRange:void 0,sequenceLmt:\"0\"}}var $={encode(e,n=new s){return e.headerId!==void 0&&e.headerId!==0&&n.uint32(8).uint32(e.headerId),e.videoId!==void 0&&e.videoId!==\"\"&&n.uint32(18).string(e.videoId),e.itag!==void 0&&e.itag!==0&&n.uint32(24).int32(e.itag),e.lmt!==void 0&&e.lmt!==\"0\"&&n.uint32(32).uint64(e.lmt),e.xtags!==void 0&&e.xtags!==\"\"&&n.uint32(42).string(e.xtags),e.startRange!==void 0&&e.startRange!==\"0\"&&n.uint32(48).int64(e.startRange),e.compressionAlgorithm!==void 0&&e.compressionAlgorithm!==0&&n.uint32(56).int32(e.compressionAlgorithm),e.isInitSeg!==void 0&&e.isInitSeg!==!1&&n.uint32(64).bool(e.isInitSeg),e.sequenceNumber!==void 0&&e.sequenceNumber!==0&&n.uint32(72).int32(e.sequenceNumber),e.bitrateBps!==void 0&&e.bitrateBps!==\"0\"&&n.uint32(80).int64(e.bitrateBps),e.startMs!==void 0&&e.startMs!==\"0\"&&n.uint32(88).int64(e.startMs),e.durationMs!==void 0&&e.durationMs!==\"0\"&&n.uint32(96).int64(e.durationMs),e.formatId!==void 0&&l.encode(e.formatId,n.uint32(106).fork()).join(),e.contentLength!==void 0&&e.contentLength!==\"0\"&&n.uint32(112).int64(e.contentLength),e.timeRange!==void 0&&T.encode(e.timeRange,n.uint32(122).fork()).join(),e.sequenceLmt!==void 0&&e.sequenceLmt!==\"0\"&&n.uint32(128).uint64(e.sequenceLmt),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=on();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==8)break;o.headerId=t.uint32();continue}case 2:{if(i!==18)break;o.videoId=t.string();continue}case 3:{if(i!==24)break;o.itag=t.int32();continue}case 4:{if(i!==32)break;o.lmt=t.uint64().toString();continue}case 5:{if(i!==42)break;o.xtags=t.string();continue}case 6:{if(i!==48)break;o.startRange=t.int64().toString();continue}case 7:{if(i!==56)break;o.compressionAlgorithm=t.int32();continue}case 8:{if(i!==64)break;o.isInitSeg=t.bool();continue}case 9:{if(i!==72)break;o.sequenceNumber=t.int32();continue}case 10:{if(i!==80)break;o.bitrateBps=t.int64().toString();continue}case 11:{if(i!==88)break;o.startMs=t.int64().toString();continue}case 12:{if(i!==96)break;o.durationMs=t.int64().toString();continue}case 13:{if(i!==106)break;o.formatId=l.decode(t,t.uint32());continue}case 14:{if(i!==112)break;o.contentLength=t.int64().toString();continue}case 15:{if(i!==122)break;o.timeRange=T.decode(t,t.uint32());continue}case 16:{if(i!==128)break;o.sequenceLmt=t.uint64().toString();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function rn(){return{formatId:void 0,startTimeMs:\"0\",durationMs:\"0\",startSegmentIndex:0,endSegmentIndex:0,timeRange:void 0,field9:void 0,field11:void 0,field12:void 0}}var S={encode(e,n=new s){return e.formatId!==void 0&&l.encode(e.formatId,n.uint32(10).fork()).join(),e.startTimeMs!==\"0\"&&n.uint32(16).int64(e.startTimeMs),e.durationMs!==\"0\"&&n.uint32(24).int64(e.durationMs),e.startSegmentIndex!==0&&n.uint32(32).int32(e.startSegmentIndex),e.endSegmentIndex!==0&&n.uint32(40).int32(e.endSegmentIndex),e.timeRange!==void 0&&T.encode(e.timeRange,n.uint32(50).fork()).join(),e.field9!==void 0&&tt.encode(e.field9,n.uint32(74).fork()).join(),e.field11!==void 0&&j.encode(e.field11,n.uint32(90).fork()).join(),e.field12!==void 0&&j.encode(e.field12,n.uint32(98).fork()).join(),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=rn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==10)break;o.formatId=l.decode(t,t.uint32());continue}case 2:{if(i!==16)break;o.startTimeMs=t.int64().toString();continue}case 3:{if(i!==24)break;o.durationMs=t.int64().toString();continue}case 4:{if(i!==32)break;o.startSegmentIndex=t.int32();continue}case 5:{if(i!==40)break;o.endSegmentIndex=t.int32();continue}case 6:{if(i!==50)break;o.timeRange=T.decode(t,t.uint32());continue}case 9:{if(i!==74)break;o.field9=tt.decode(t,t.uint32());continue}case 11:{if(i!==90)break;o.field11=j.decode(t,t.uint32());continue}case 12:{if(i!==98)break;o.field12=j.decode(t,t.uint32());continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function an(){return{field1:[]}}var tt={encode(e,n=new s){for(let t of e.field1)nt.encode(t,n.uint32(10).fork()).join();return n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=an();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==10)break;o.field1.push(nt.decode(t,t.uint32()));continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function dn(){return{videoId:\"\",lmt:\"0\"}}var nt={encode(e,n=new s){return e.videoId!==void 0&&e.videoId!==\"\"&&n.uint32(10).string(e.videoId),e.lmt!==void 0&&e.lmt!==\"0\"&&n.uint32(16).uint64(e.lmt),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=dn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==10)break;o.videoId=t.string();continue}case 2:{if(i!==16)break;o.lmt=t.uint64().toString();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function sn(){return{field1:0,field2:0,field3:0}}var j={encode(e,n=new s){return e.field1!==void 0&&e.field1!==0&&n.uint32(8).int32(e.field1),e.field2!==void 0&&e.field2!==0&&n.uint32(16).int32(e.field2),e.field3!==void 0&&e.field3!==0&&n.uint32(24).int32(e.field3),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=sn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==8)break;o.field1=t.int32();continue}case 2:{if(i!==16)break;o.field2=t.int32();continue}case 3:{if(i!==24)break;o.field3=t.int32();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function cn(){return{videoFormatCapabilities:[],audioFormatCapabilities:[],hdrModeBitmask:0}}var U={encode(e,n=new s){for(let t of e.videoFormatCapabilities)it.encode(t,n.uint32(10).fork()).join();for(let t of e.audioFormatCapabilities)ot.encode(t,n.uint32(18).fork()).join();return e.hdrModeBitmask!==void 0&&e.hdrModeBitmask!==0&&n.uint32(40).int32(e.hdrModeBitmask),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=cn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==10)break;o.videoFormatCapabilities.push(it.decode(t,t.uint32()));continue}case 2:{if(i!==18)break;o.audioFormatCapabilities.push(ot.decode(t,t.uint32()));continue}case 5:{if(i!==40)break;o.hdrModeBitmask=t.int32();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function un(){return{videoCodec:0,maxHeight:0,maxWidth:0,maxFramerate:0,maxBitrateBps:0,is10BitSupported:!1}}var it={encode(e,n=new s){return e.videoCodec!==void 0&&e.videoCodec!==0&&n.uint32(8).int32(e.videoCodec),e.maxHeight!==void 0&&e.maxHeight!==0&&n.uint32(24).int32(e.maxHeight),e.maxWidth!==void 0&&e.maxWidth!==0&&n.uint32(32).int32(e.maxWidth),e.maxFramerate!==void 0&&e.maxFramerate!==0&&n.uint32(88).int32(e.maxFramerate),e.maxBitrateBps!==void 0&&e.maxBitrateBps!==0&&n.uint32(96).int32(e.maxBitrateBps),e.is10BitSupported!==void 0&&e.is10BitSupported!==!1&&n.uint32(120).bool(e.is10BitSupported),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=un();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==8)break;o.videoCodec=t.int32();continue}case 3:{if(i!==24)break;o.maxHeight=t.int32();continue}case 4:{if(i!==32)break;o.maxWidth=t.int32();continue}case 11:{if(i!==88)break;o.maxFramerate=t.int32();continue}case 12:{if(i!==96)break;o.maxBitrateBps=t.int32();continue}case 15:{if(i!==120)break;o.is10BitSupported=t.bool();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function fn(){return{audioCodec:0,numChannels:0,maxBitrateBps:0,spatialCapabilityBitmask:0}}var ot={encode(e,n=new s){return e.audioCodec!==void 0&&e.audioCodec!==0&&n.uint32(8).int32(e.audioCodec),e.numChannels!==void 0&&e.numChannels!==0&&n.uint32(16).int32(e.numChannels),e.maxBitrateBps!==void 0&&e.maxBitrateBps!==0&&n.uint32(24).int32(e.maxBitrateBps),e.spatialCapabilityBitmask!==void 0&&e.spatialCapabilityBitmask!==0&&n.uint32(48).int32(e.spatialCapabilityBitmask),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=fn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==8)break;o.audioCodec=t.int32();continue}case 2:{if(i!==16)break;o.numChannels=t.int32();continue}case 3:{if(i!==24)break;o.maxBitrateBps=t.int32();continue}case 6:{if(i!==48)break;o.spatialCapabilityBitmask=t.int32();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function ln(){return{hmac:new Uint8Array(0),iv:new Uint8Array(0),compressionType:0}}var w={encode(e,n=new s){return e.hmac!==void 0&&e.hmac.length!==0&&n.uint32(34).bytes(e.hmac),e.iv!==void 0&&e.iv.length!==0&&n.uint32(42).bytes(e.iv),e.compressionType!==void 0&&e.compressionType!==0&&n.uint32(48).int32(e.compressionType),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=ln();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 4:{if(i!==34)break;o.hmac=t.bytes();continue}case 5:{if(i!==42)break;o.iv=t.bytes();continue}case 6:{if(i!==48)break;o.compressionType=t.int32();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function hn(){return{resolution:0,field2:0,videoFmt:void 0,audioFmt:void 0}}var M={encode(e,n=new s){return e.resolution!==void 0&&e.resolution!==0&&n.uint32(8).int32(e.resolution),e.field2!==void 0&&e.field2!==0&&n.uint32(16).int32(e.field2),e.videoFmt!==void 0&&l.encode(e.videoFmt,n.uint32(58).fork()).join(),e.audioFmt!==void 0&&l.encode(e.audioFmt,n.uint32(66).fork()).join(),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=hn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==8)break;o.resolution=t.int32();continue}case 2:{if(i!==16)break;o.field2=t.int32();continue}case 7:{if(i!==58)break;o.videoFmt=l.decode(t,t.uint32());continue}case 8:{if(i!==66)break;o.audioFmt=l.decode(t,t.uint32());continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function pn(){return{startMinReadaheadPolicy:void 0,resumeMinReadaheadPolicy:void 0}}var rt={encode(e,n=new s){return e.startMinReadaheadPolicy!==void 0&&Q.encode(e.startMinReadaheadPolicy,n.uint32(10).fork()).join(),e.resumeMinReadaheadPolicy!==void 0&&Q.encode(e.resumeMinReadaheadPolicy,n.uint32(18).fork()).join(),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=pn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==10)break;o.startMinReadaheadPolicy=Q.decode(t,t.uint32());continue}case 2:{if(i!==18)break;o.resumeMinReadaheadPolicy=Q.decode(t,t.uint32());continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function En(){return{minReadaheadMs:0,minBandwidthBytesPerSec:0}}var Q={encode(e,n=new s){return e.minReadaheadMs!==void 0&&e.minReadaheadMs!==0&&n.uint32(16).int32(e.minReadaheadMs),e.minBandwidthBytesPerSec!==void 0&&e.minBandwidthBytesPerSec!==0&&n.uint32(8).int32(e.minBandwidthBytesPerSec),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=En();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 2:{if(i!==16)break;o.minReadaheadMs=t.int32();continue}case 1:{if(i!==8)break;o.minBandwidthBytesPerSec=t.int32();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function bn(){return{timeSinceLastManualFormatSelectionMs:\"0\",lastManualDirection:0,lastManualSelectedResolution:0,detailedNetworkType:0,clientViewportWidth:0,clientViewportHeight:0,clientBitrateCapBytesPerSec:\"0\",stickyResolution:0,clientViewportIsFlexible:!1,bandwidthEstimate:\"0\",minAudioQuality:0,maxAudioQuality:0,videoQualitySetting:0,audioRoute:0,playerTimeMs:\"0\",timeSinceLastSeek:\"0\",dataSaverMode:!1,networkMeteredState:0,visibility:0,playbackRate:0,elapsedWallTimeMs:\"0\",mediaCapabilities:void 0,timeSinceLastActionMs:\"0\",enabledTrackTypesBitfield:0,maxPacingRate:0,playerState:\"0\",drcEnabled:!1,field48:0,field50:0,field51:0,sabrReportRequestCancellationInfo:0,disableStreamingXhr:!1,field57:\"0\",preferVp9:!1,av1QualityThreshold:0,field60:0,isPrefetch:!1,sabrSupportQualityConstraints:!1,sabrLicenseConstraint:new Uint8Array(0),allowProximaLiveLatency:0,sabrForceProxima:0,field67:0,sabrForceMaxNetworkInterruptionDurationMs:\"0\",audioTrackId:\"\",enableVoiceBoost:!1,playbackAuthorization:void 0}}var C={encode(e,n=new s){return e.timeSinceLastManualFormatSelectionMs!==void 0&&e.timeSinceLastManualFormatSelectionMs!==\"0\"&&n.uint32(104).int64(e.timeSinceLastManualFormatSelectionMs),e.lastManualDirection!==void 0&&e.lastManualDirection!==0&&n.uint32(112).sint32(e.lastManualDirection),e.lastManualSelectedResolution!==void 0&&e.lastManualSelectedResolution!==0&&n.uint32(128).int32(e.lastManualSelectedResolution),e.detailedNetworkType!==void 0&&e.detailedNetworkType!==0&&n.uint32(136).int32(e.detailedNetworkType),e.clientViewportWidth!==void 0&&e.clientViewportWidth!==0&&n.uint32(144).int32(e.clientViewportWidth),e.clientViewportHeight!==void 0&&e.clientViewportHeight!==0&&n.uint32(152).int32(e.clientViewportHeight),e.clientBitrateCapBytesPerSec!==void 0&&e.clientBitrateCapBytesPerSec!==\"0\"&&n.uint32(160).int64(e.clientBitrateCapBytesPerSec),e.stickyResolution!==void 0&&e.stickyResolution!==0&&n.uint32(168).int32(e.stickyResolution),e.clientViewportIsFlexible!==void 0&&e.clientViewportIsFlexible!==!1&&n.uint32(176).bool(e.clientViewportIsFlexible),e.bandwidthEstimate!==void 0&&e.bandwidthEstimate!==\"0\"&&n.uint32(184).int64(e.bandwidthEstimate),e.minAudioQuality!==void 0&&e.minAudioQuality!==0&&n.uint32(192).int32(e.minAudioQuality),e.maxAudioQuality!==void 0&&e.maxAudioQuality!==0&&n.uint32(200).int32(e.maxAudioQuality),e.videoQualitySetting!==void 0&&e.videoQualitySetting!==0&&n.uint32(208).int32(e.videoQualitySetting),e.audioRoute!==void 0&&e.audioRoute!==0&&n.uint32(216).int32(e.audioRoute),e.playerTimeMs!==void 0&&e.playerTimeMs!==\"0\"&&n.uint32(224).int64(e.playerTimeMs),e.timeSinceLastSeek!==void 0&&e.timeSinceLastSeek!==\"0\"&&n.uint32(232).int64(e.timeSinceLastSeek),e.dataSaverMode!==void 0&&e.dataSaverMode!==!1&&n.uint32(240).bool(e.dataSaverMode),e.networkMeteredState!==void 0&&e.networkMeteredState!==0&&n.uint32(256).int32(e.networkMeteredState),e.visibility!==void 0&&e.visibility!==0&&n.uint32(272).int32(e.visibility),e.playbackRate!==void 0&&e.playbackRate!==0&&n.uint32(285).float(e.playbackRate),e.elapsedWallTimeMs!==void 0&&e.elapsedWallTimeMs!==\"0\"&&n.uint32(288).int64(e.elapsedWallTimeMs),e.mediaCapabilities!==void 0&&U.encode(e.mediaCapabilities,n.uint32(306).fork()).join(),e.timeSinceLastActionMs!==void 0&&e.timeSinceLastActionMs!==\"0\"&&n.uint32(312).int64(e.timeSinceLastActionMs),e.enabledTrackTypesBitfield!==void 0&&e.enabledTrackTypesBitfield!==0&&n.uint32(320).int32(e.enabledTrackTypesBitfield),e.maxPacingRate!==void 0&&e.maxPacingRate!==0&&n.uint32(344).int32(e.maxPacingRate),e.playerState!==void 0&&e.playerState!==\"0\"&&n.uint32(352).int64(e.playerState),e.drcEnabled!==void 0&&e.drcEnabled!==!1&&n.uint32(368).bool(e.drcEnabled),e.field48!==void 0&&e.field48!==0&&n.uint32(384).int32(e.field48),e.field50!==void 0&&e.field50!==0&&n.uint32(400).int32(e.field50),e.field51!==void 0&&e.field51!==0&&n.uint32(408).int32(e.field51),e.sabrReportRequestCancellationInfo!==void 0&&e.sabrReportRequestCancellationInfo!==0&&n.uint32(432).int32(e.sabrReportRequestCancellationInfo),e.disableStreamingXhr!==void 0&&e.disableStreamingXhr!==!1&&n.uint32(448).bool(e.disableStreamingXhr),e.field57!==void 0&&e.field57!==\"0\"&&n.uint32(456).int64(e.field57),e.preferVp9!==void 0&&e.preferVp9!==!1&&n.uint32(464).bool(e.preferVp9),e.av1QualityThreshold!==void 0&&e.av1QualityThreshold!==0&&n.uint32(472).int32(e.av1QualityThreshold),e.field60!==void 0&&e.field60!==0&&n.uint32(480).int32(e.field60),e.isPrefetch!==void 0&&e.isPrefetch!==!1&&n.uint32(488).bool(e.isPrefetch),e.sabrSupportQualityConstraints!==void 0&&e.sabrSupportQualityConstraints!==!1&&n.uint32(496).bool(e.sabrSupportQualityConstraints),e.sabrLicenseConstraint!==void 0&&e.sabrLicenseConstraint.length!==0&&n.uint32(506).bytes(e.sabrLicenseConstraint),e.allowProximaLiveLatency!==void 0&&e.allowProximaLiveLatency!==0&&n.uint32(512).int32(e.allowProximaLiveLatency),e.sabrForceProxima!==void 0&&e.sabrForceProxima!==0&&n.uint32(528).int32(e.sabrForceProxima),e.field67!==void 0&&e.field67!==0&&n.uint32(536).int32(e.field67),e.sabrForceMaxNetworkInterruptionDurationMs!==void 0&&e.sabrForceMaxNetworkInterruptionDurationMs!==\"0\"&&n.uint32(544).int64(e.sabrForceMaxNetworkInterruptionDurationMs),e.audioTrackId!==void 0&&e.audioTrackId!==\"\"&&n.uint32(554).string(e.audioTrackId),e.enableVoiceBoost!==void 0&&e.enableVoiceBoost!==!1&&n.uint32(608).bool(e.enableVoiceBoost),e.playbackAuthorization!==void 0&&g.encode(e.playbackAuthorization,n.uint32(634).fork()).join(),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=bn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 13:{if(i!==104)break;o.timeSinceLastManualFormatSelectionMs=t.int64().toString();continue}case 14:{if(i!==112)break;o.lastManualDirection=t.sint32();continue}case 16:{if(i!==128)break;o.lastManualSelectedResolution=t.int32();continue}case 17:{if(i!==136)break;o.detailedNetworkType=t.int32();continue}case 18:{if(i!==144)break;o.clientViewportWidth=t.int32();continue}case 19:{if(i!==152)break;o.clientViewportHeight=t.int32();continue}case 20:{if(i!==160)break;o.clientBitrateCapBytesPerSec=t.int64().toString();continue}case 21:{if(i!==168)break;o.stickyResolution=t.int32();continue}case 22:{if(i!==176)break;o.clientViewportIsFlexible=t.bool();continue}case 23:{if(i!==184)break;o.bandwidthEstimate=t.int64().toString();continue}case 24:{if(i!==192)break;o.minAudioQuality=t.int32();continue}case 25:{if(i!==200)break;o.maxAudioQuality=t.int32();continue}case 26:{if(i!==208)break;o.videoQualitySetting=t.int32();continue}case 27:{if(i!==216)break;o.audioRoute=t.int32();continue}case 28:{if(i!==224)break;o.playerTimeMs=t.int64().toString();continue}case 29:{if(i!==232)break;o.timeSinceLastSeek=t.int64().toString();continue}case 30:{if(i!==240)break;o.dataSaverMode=t.bool();continue}case 32:{if(i!==256)break;o.networkMeteredState=t.int32();continue}case 34:{if(i!==272)break;o.visibility=t.int32();continue}case 35:{if(i!==285)break;o.playbackRate=t.float();continue}case 36:{if(i!==288)break;o.elapsedWallTimeMs=t.int64().toString();continue}case 38:{if(i!==306)break;o.mediaCapabilities=U.decode(t,t.uint32());continue}case 39:{if(i!==312)break;o.timeSinceLastActionMs=t.int64().toString();continue}case 40:{if(i!==320)break;o.enabledTrackTypesBitfield=t.int32();continue}case 43:{if(i!==344)break;o.maxPacingRate=t.int32();continue}case 44:{if(i!==352)break;o.playerState=t.int64().toString();continue}case 46:{if(i!==368)break;o.drcEnabled=t.bool();continue}case 48:{if(i!==384)break;o.field48=t.int32();continue}case 50:{if(i!==400)break;o.field50=t.int32();continue}case 51:{if(i!==408)break;o.field51=t.int32();continue}case 54:{if(i!==432)break;o.sabrReportRequestCancellationInfo=t.int32();continue}case 56:{if(i!==448)break;o.disableStreamingXhr=t.bool();continue}case 57:{if(i!==456)break;o.field57=t.int64().toString();continue}case 58:{if(i!==464)break;o.preferVp9=t.bool();continue}case 59:{if(i!==472)break;o.av1QualityThreshold=t.int32();continue}case 60:{if(i!==480)break;o.field60=t.int32();continue}case 61:{if(i!==488)break;o.isPrefetch=t.bool();continue}case 62:{if(i!==496)break;o.sabrSupportQualityConstraints=t.bool();continue}case 63:{if(i!==506)break;o.sabrLicenseConstraint=t.bytes();continue}case 64:{if(i!==512)break;o.allowProximaLiveLatency=t.int32();continue}case 66:{if(i!==528)break;o.sabrForceProxima=t.int32();continue}case 67:{if(i!==536)break;o.field67=t.int32();continue}case 68:{if(i!==544)break;o.sabrForceMaxNetworkInterruptionDurationMs=t.int64().toString();continue}case 69:{if(i!==554)break;o.audioTrackId=t.string();continue}case 76:{if(i!==608)break;o.enableVoiceBoost=t.bool();continue}case 79:{if(i!==634)break;o.playbackAuthorization=g.decode(t,t.uint32());continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function _n(){return{clientInfo:void 0,poToken:new Uint8Array(0),playbackCookie:new Uint8Array(0),field4:new Uint8Array(0),sabrContexts:[],unsentSabrContexts:[],field7:\"\",field8:void 0}}var P={encode(e,n=new s){e.clientInfo!==void 0&&X.encode(e.clientInfo,n.uint32(10).fork()).join(),e.poToken!==void 0&&e.poToken.length!==0&&n.uint32(18).bytes(e.poToken),e.playbackCookie!==void 0&&e.playbackCookie.length!==0&&n.uint32(26).bytes(e.playbackCookie),e.field4!==void 0&&e.field4.length!==0&&n.uint32(34).bytes(e.field4);for(let t of e.sabrContexts)dt.encode(t,n.uint32(42).fork()).join();n.uint32(50).fork();for(let t of e.unsentSabrContexts)n.int32(t);return n.join(),e.field7!==void 0&&e.field7!==\"\"&&n.uint32(58).string(e.field7),e.field8!==void 0&&st.encode(e.field8,n.uint32(66).fork()).join(),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=_n();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==10)break;o.clientInfo=X.decode(t,t.uint32());continue}case 2:{if(i!==18)break;o.poToken=t.bytes();continue}case 3:{if(i!==26)break;o.playbackCookie=t.bytes();continue}case 4:{if(i!==34)break;o.field4=t.bytes();continue}case 5:{if(i!==42)break;o.sabrContexts.push(dt.decode(t,t.uint32()));continue}case 6:{if(i===48){o.unsentSabrContexts.push(t.int32());continue}if(i===50){let d=t.uint32()+t.pos;for(;t.pos<d;)o.unsentSabrContexts.push(t.int32());continue}break}case 7:{if(i!==58)break;o.field7=t.string();continue}case 8:{if(i!==66)break;o.field8=st.decode(t,t.uint32());continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function Sn(){return{deviceMake:\"\",deviceModel:\"\",clientName:0,clientVersion:\"\",osName:\"\",osVersion:\"\",acceptLanguage:\"\",acceptRegion:\"\",screenWidthPoints:0,screenHeightPoints:0,screenWidthInches:0,screenHeightInches:0,screenPixelDensity:0,clientFormFactor:0,gmscoreVersionCode:0,windowWidthPoints:0,windowHeightPoints:0,androidSdkVersion:0,screenDensityFloat:0,utcOffsetMinutes:\"0\",timeZone:\"\",chipset:\"\",glDeviceInfo:void 0}}var X={encode(e,n=new s){return e.deviceMake!==void 0&&e.deviceMake!==\"\"&&n.uint32(98).string(e.deviceMake),e.deviceModel!==void 0&&e.deviceModel!==\"\"&&n.uint32(106).string(e.deviceModel),e.clientName!==void 0&&e.clientName!==0&&n.uint32(128).int32(e.clientName),e.clientVersion!==void 0&&e.clientVersion!==\"\"&&n.uint32(138).string(e.clientVersion),e.osName!==void 0&&e.osName!==\"\"&&n.uint32(146).string(e.osName),e.osVersion!==void 0&&e.osVersion!==\"\"&&n.uint32(154).string(e.osVersion),e.acceptLanguage!==void 0&&e.acceptLanguage!==\"\"&&n.uint32(170).string(e.acceptLanguage),e.acceptRegion!==void 0&&e.acceptRegion!==\"\"&&n.uint32(178).string(e.acceptRegion),e.screenWidthPoints!==void 0&&e.screenWidthPoints!==0&&n.uint32(296).int32(e.screenWidthPoints),e.screenHeightPoints!==void 0&&e.screenHeightPoints!==0&&n.uint32(304).int32(e.screenHeightPoints),e.screenWidthInches!==void 0&&e.screenWidthInches!==0&&n.uint32(317).float(e.screenWidthInches),e.screenHeightInches!==void 0&&e.screenHeightInches!==0&&n.uint32(325).float(e.screenHeightInches),e.screenPixelDensity!==void 0&&e.screenPixelDensity!==0&&n.uint32(328).int32(e.screenPixelDensity),e.clientFormFactor!==void 0&&e.clientFormFactor!==0&&n.uint32(368).int32(e.clientFormFactor),e.gmscoreVersionCode!==void 0&&e.gmscoreVersionCode!==0&&n.uint32(400).int32(e.gmscoreVersionCode),e.windowWidthPoints!==void 0&&e.windowWidthPoints!==0&&n.uint32(440).int32(e.windowWidthPoints),e.windowHeightPoints!==void 0&&e.windowHeightPoints!==0&&n.uint32(448).int32(e.windowHeightPoints),e.androidSdkVersion!==void 0&&e.androidSdkVersion!==0&&n.uint32(512).int32(e.androidSdkVersion),e.screenDensityFloat!==void 0&&e.screenDensityFloat!==0&&n.uint32(525).float(e.screenDensityFloat),e.utcOffsetMinutes!==void 0&&e.utcOffsetMinutes!==\"0\"&&n.uint32(536).int64(e.utcOffsetMinutes),e.timeZone!==void 0&&e.timeZone!==\"\"&&n.uint32(642).string(e.timeZone),e.chipset!==void 0&&e.chipset!==\"\"&&n.uint32(738).string(e.chipset),e.glDeviceInfo!==void 0&&at.encode(e.glDeviceInfo,n.uint32(818).fork()).join(),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=Sn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 12:{if(i!==98)break;o.deviceMake=t.string();continue}case 13:{if(i!==106)break;o.deviceModel=t.string();continue}case 16:{if(i!==128)break;o.clientName=t.int32();continue}case 17:{if(i!==138)break;o.clientVersion=t.string();continue}case 18:{if(i!==146)break;o.osName=t.string();continue}case 19:{if(i!==154)break;o.osVersion=t.string();continue}case 21:{if(i!==170)break;o.acceptLanguage=t.string();continue}case 22:{if(i!==178)break;o.acceptRegion=t.string();continue}case 37:{if(i!==296)break;o.screenWidthPoints=t.int32();continue}case 38:{if(i!==304)break;o.screenHeightPoints=t.int32();continue}case 39:{if(i!==317)break;o.screenWidthInches=t.float();continue}case 40:{if(i!==325)break;o.screenHeightInches=t.float();continue}case 41:{if(i!==328)break;o.screenPixelDensity=t.int32();continue}case 46:{if(i!==368)break;o.clientFormFactor=t.int32();continue}case 50:{if(i!==400)break;o.gmscoreVersionCode=t.int32();continue}case 55:{if(i!==440)break;o.windowWidthPoints=t.int32();continue}case 56:{if(i!==448)break;o.windowHeightPoints=t.int32();continue}case 64:{if(i!==512)break;o.androidSdkVersion=t.int32();continue}case 65:{if(i!==525)break;o.screenDensityFloat=t.float();continue}case 67:{if(i!==536)break;o.utcOffsetMinutes=t.int64().toString();continue}case 80:{if(i!==642)break;o.timeZone=t.string();continue}case 92:{if(i!==738)break;o.chipset=t.string();continue}case 102:{if(i!==818)break;o.glDeviceInfo=at.decode(t,t.uint32());continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function Rn(){return{glRenderer:\"\",glEsVersionMajor:0,glEsVersionMinor:0}}var at={encode(e,n=new s){return e.glRenderer!==void 0&&e.glRenderer!==\"\"&&n.uint32(10).string(e.glRenderer),e.glEsVersionMajor!==void 0&&e.glEsVersionMajor!==0&&n.uint32(16).int32(e.glEsVersionMajor),e.glEsVersionMinor!==void 0&&e.glEsVersionMinor!==0&&n.uint32(24).int32(e.glEsVersionMinor),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=Rn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==10)break;o.glRenderer=t.string();continue}case 2:{if(i!==16)break;o.glEsVersionMajor=t.int32();continue}case 3:{if(i!==24)break;o.glEsVersionMinor=t.int32();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function In(){return{type:0,value:new Uint8Array(0)}}var dt={encode(e,n=new s){return e.type!==void 0&&e.type!==0&&n.uint32(8).int32(e.type),e.value!==void 0&&e.value.length!==0&&n.uint32(18).bytes(e.value),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=In();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==8)break;o.type=t.int32();continue}case 2:{if(i!==18)break;o.value=t.bytes();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function kn(){return{field1:new Uint8Array(0),field2:void 0}}var st={encode(e,n=new s){return e.field1!==void 0&&e.field1.length!==0&&n.uint32(10).bytes(e.field1),e.field2!==void 0&&ct.encode(e.field2,n.uint32(18).fork()).join(),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=kn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==10)break;o.field1=t.bytes();continue}case 2:{if(i!==18)break;o.field2=ct.decode(t,t.uint32());continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function Tn(){return{code:0,message:\"\"}}var ct={encode(e,n=new s){return e.code!==void 0&&e.code!==0&&n.uint32(8).int32(e.code),e.message!==void 0&&e.message!==\"\"&&n.uint32(18).string(e.message),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=Tn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==8)break;o.code=t.int32();continue}case 2:{if(i!==18)break;o.message=t.string();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function An(){return{clientAbrState:void 0,selectedFormatIds:[],bufferedRanges:[],playerTimeMs:\"0\",videoPlaybackUstreamerConfig:new Uint8Array(0),field6:void 0,preferredAudioFormatIds:[],preferredVideoFormatIds:[],preferredSubtitleFormatIds:[],streamerContext:void 0,field21:void 0,field22:0,field23:0,field1000:[]}}var Z={encode(e,n=new s){e.clientAbrState!==void 0&&C.encode(e.clientAbrState,n.uint32(10).fork()).join();for(let t of e.selectedFormatIds)l.encode(t,n.uint32(18).fork()).join();for(let t of e.bufferedRanges)S.encode(t,n.uint32(26).fork()).join();e.playerTimeMs!==void 0&&e.playerTimeMs!==\"0\"&&n.uint32(32).int64(e.playerTimeMs),e.videoPlaybackUstreamerConfig!==void 0&&e.videoPlaybackUstreamerConfig.length!==0&&n.uint32(42).bytes(e.videoPlaybackUstreamerConfig),e.field6!==void 0&&ut.encode(e.field6,n.uint32(50).fork()).join();for(let t of e.preferredAudioFormatIds)l.encode(t,n.uint32(130).fork()).join();for(let t of e.preferredVideoFormatIds)l.encode(t,n.uint32(138).fork()).join();for(let t of e.preferredSubtitleFormatIds)l.encode(t,n.uint32(146).fork()).join();e.streamerContext!==void 0&&P.encode(e.streamerContext,n.uint32(154).fork()).join(),e.field21!==void 0&&ft.encode(e.field21,n.uint32(170).fork()).join(),e.field22!==void 0&&e.field22!==0&&n.uint32(176).int32(e.field22),e.field23!==void 0&&e.field23!==0&&n.uint32(184).int32(e.field23);for(let t of e.field1000)lt.encode(t,n.uint32(8002).fork()).join();return n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=An();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==10)break;o.clientAbrState=C.decode(t,t.uint32());continue}case 2:{if(i!==18)break;o.selectedFormatIds.push(l.decode(t,t.uint32()));continue}case 3:{if(i!==26)break;o.bufferedRanges.push(S.decode(t,t.uint32()));continue}case 4:{if(i!==32)break;o.playerTimeMs=t.int64().toString();continue}case 5:{if(i!==42)break;o.videoPlaybackUstreamerConfig=t.bytes();continue}case 6:{if(i!==50)break;o.field6=ut.decode(t,t.uint32());continue}case 16:{if(i!==130)break;o.preferredAudioFormatIds.push(l.decode(t,t.uint32()));continue}case 17:{if(i!==138)break;o.preferredVideoFormatIds.push(l.decode(t,t.uint32()));continue}case 18:{if(i!==146)break;o.preferredSubtitleFormatIds.push(l.decode(t,t.uint32()));continue}case 19:{if(i!==154)break;o.streamerContext=P.decode(t,t.uint32());continue}case 21:{if(i!==170)break;o.field21=ft.decode(t,t.uint32());continue}case 22:{if(i!==176)break;o.field22=t.int32();continue}case 23:{if(i!==184)break;o.field23=t.int32();continue}case 1e3:{if(i!==8002)break;o.field1000.push(lt.decode(t,t.uint32()));continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function yn(){return{formatId:void 0,lmt:\"0\",sequenceNumber:0,timeRange:void 0,field5:0}}var ut={encode(e,n=new s){return e.formatId!==void 0&&l.encode(e.formatId,n.uint32(10).fork()).join(),e.lmt!==void 0&&e.lmt!==\"0\"&&n.uint32(16).sint64(e.lmt),e.sequenceNumber!==void 0&&e.sequenceNumber!==0&&n.uint32(24).int32(e.sequenceNumber),e.timeRange!==void 0&&T.encode(e.timeRange,n.uint32(34).fork()).join(),e.field5!==void 0&&e.field5!==0&&n.uint32(40).int32(e.field5),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=yn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==10)break;o.formatId=l.decode(t,t.uint32());continue}case 2:{if(i!==16)break;o.lmt=t.sint64().toString();continue}case 3:{if(i!==24)break;o.sequenceNumber=t.int32();continue}case 4:{if(i!==34)break;o.timeRange=T.decode(t,t.uint32());continue}case 5:{if(i!==40)break;o.field5=t.int32();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function Nn(){return{field1:[],field2:new Uint8Array(0),field3:\"\",field4:0,field5:0,field6:\"\"}}var ft={encode(e,n=new s){for(let t of e.field1)n.uint32(10).string(t);return e.field2!==void 0&&e.field2.length!==0&&n.uint32(18).bytes(e.field2),e.field3!==void 0&&e.field3!==\"\"&&n.uint32(26).string(e.field3),e.field4!==void 0&&e.field4!==0&&n.uint32(32).int32(e.field4),e.field5!==void 0&&e.field5!==0&&n.uint32(40).int32(e.field5),e.field6!==void 0&&e.field6!==\"\"&&n.uint32(50).string(e.field6),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=Nn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==10)break;o.field1.push(t.string());continue}case 2:{if(i!==18)break;o.field2=t.bytes();continue}case 3:{if(i!==26)break;o.field3=t.string();continue}case 4:{if(i!==32)break;o.field4=t.int32();continue}case 5:{if(i!==40)break;o.field5=t.int32();continue}case 6:{if(i!==50)break;o.field6=t.string();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function Cn(){return{formatIds:[],ud:[],clipId:\"\"}}var lt={encode(e,n=new s){for(let t of e.formatIds)l.encode(t,n.uint32(10).fork()).join();for(let t of e.ud)S.encode(t,n.uint32(18).fork()).join();return e.clipId!==void 0&&e.clipId!==\"\"&&n.uint32(26).string(e.clipId),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=Cn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==10)break;o.formatIds.push(l.decode(t,t.uint32()));continue}case 2:{if(i!==18)break;o.ud.push(S.decode(t,t.uint32()));continue}case 3:{if(i!==26)break;o.clipId=t.string();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function Pn(){return{targetAudioReadaheadMs:0,targetVideoReadaheadMs:0,maxTimeSinceLastRequestMs:0,backoffTimeMs:0,minAudioReadaheadMs:0,minVideoReadaheadMs:0,playbackCookie:void 0,videoId:\"\"}}var J={encode(e,n=new s){return e.targetAudioReadaheadMs!==void 0&&e.targetAudioReadaheadMs!==0&&n.uint32(8).int32(e.targetAudioReadaheadMs),e.targetVideoReadaheadMs!==void 0&&e.targetVideoReadaheadMs!==0&&n.uint32(16).int32(e.targetVideoReadaheadMs),e.maxTimeSinceLastRequestMs!==void 0&&e.maxTimeSinceLastRequestMs!==0&&n.uint32(24).int32(e.maxTimeSinceLastRequestMs),e.backoffTimeMs!==void 0&&e.backoffTimeMs!==0&&n.uint32(32).int32(e.backoffTimeMs),e.minAudioReadaheadMs!==void 0&&e.minAudioReadaheadMs!==0&&n.uint32(40).int32(e.minAudioReadaheadMs),e.minVideoReadaheadMs!==void 0&&e.minVideoReadaheadMs!==0&&n.uint32(48).int32(e.minVideoReadaheadMs),e.playbackCookie!==void 0&&M.encode(e.playbackCookie,n.uint32(58).fork()).join(),e.videoId!==void 0&&e.videoId!==\"\"&&n.uint32(66).string(e.videoId),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=Pn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==8)break;o.targetAudioReadaheadMs=t.int32();continue}case 2:{if(i!==16)break;o.targetVideoReadaheadMs=t.int32();continue}case 3:{if(i!==24)break;o.maxTimeSinceLastRequestMs=t.int32();continue}case 4:{if(i!==32)break;o.backoffTimeMs=t.int32();continue}case 5:{if(i!==40)break;o.minAudioReadaheadMs=t.int32();continue}case 6:{if(i!==48)break;o.minVideoReadaheadMs=t.int32();continue}case 7:{if(i!==58)break;o.playbackCookie=M.decode(t,t.uint32());continue}case 8:{if(i!==66)break;o.videoId=t.string();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function mn(){return{N0:0,items:[],jq:0}}var pt={encode(e,n=new s){e.N0!==void 0&&e.N0!==0&&n.uint32(8).int32(e.N0);for(let t of e.items)ht.encode(t,n.uint32(18).fork()).join();return e.jq!==void 0&&e.jq!==0&&n.uint32(24).int32(e.jq),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=mn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==8)break;o.N0=t.int32();continue}case 2:{if(i!==18)break;o.items.push(ht.decode(t,t.uint32()));continue}case 3:{if(i!==24)break;o.jq=t.int32();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function Mn(){return{fR:0,NK:0,minReadaheadMs:0}}var ht={encode(e,n=new s){return e.fR!==void 0&&e.fR!==0&&n.uint32(8).int32(e.fR),e.NK!==void 0&&e.NK!==0&&n.uint32(16).int32(e.NK),e.minReadaheadMs!==void 0&&e.minReadaheadMs!==0&&n.uint32(24).int32(e.minReadaheadMs),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=Mn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==8)break;o.fR=t.int32();continue}case 2:{if(i!==16)break;o.NK=t.int32();continue}case 3:{if(i!==24)break;o.minReadaheadMs=t.int32();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function On(){return{token:\"\"}}var Et={encode(e,n=new s){return e.token!==void 0&&e.token!==\"\"&&n.uint32(10).string(e.token),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=On();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==10)break;o.token=t.string();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function xn(){return{type:\"\",code:0}}var ee={encode(e,n=new s){return e.type!==void 0&&e.type!==\"\"&&n.uint32(10).string(e.type),e.code!==void 0&&e.code!==0&&n.uint32(16).int32(e.code),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=xn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==10)break;o.type=t.string();continue}case 2:{if(i!==16)break;o.code=t.int32();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function Bn(){return{url:\"\"}}var te={encode(e,n=new s){return e.url!==void 0&&e.url!==\"\"&&n.uint32(10).string(e.url),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=Bn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==10)break;o.url=t.string();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function Ln(){return{seekMediaTime:\"0\",seekMediaTimescale:0,seekSource:0}}var bt={encode(e,n=new s){return e.seekMediaTime!==void 0&&e.seekMediaTime!==\"0\"&&n.uint32(8).int64(e.seekMediaTime),e.seekMediaTimescale!==void 0&&e.seekMediaTimescale!==0&&n.uint32(16).int32(e.seekMediaTimescale),e.seekSource!==void 0&&e.seekSource!==0&&n.uint32(24).int32(e.seekSource),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=Ln();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==8)break;o.seekMediaTime=t.int64().toString();continue}case 2:{if(i!==16)break;o.seekMediaTimescale=t.int32();continue}case 3:{if(i!==24)break;o.seekSource=t.int32();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function Dn(){return{context:new Uint8Array(0),encryptedOnesieInnertubeRequest:new Uint8Array(0),encryptedClientKey:new Uint8Array(0),iv:new Uint8Array(0),hmac:new Uint8Array(0),reverseProxyConfig:\"\",serializeResponseAsJson:!1,enableAdPlacementsPreroll:!1,enableCompression:!1,ustreamerFlags:void 0,unencryptedOnesieInnertubeRequest:new Uint8Array(0),useJsonformatterToParsePlayerResponse:!1}}var F={encode(e,n=new s){return e.context!==void 0&&e.context.length!==0&&n.uint32(10).bytes(e.context),e.encryptedOnesieInnertubeRequest!==void 0&&e.encryptedOnesieInnertubeRequest.length!==0&&n.uint32(18).bytes(e.encryptedOnesieInnertubeRequest),e.encryptedClientKey!==void 0&&e.encryptedClientKey.length!==0&&n.uint32(42).bytes(e.encryptedClientKey),e.iv!==void 0&&e.iv.length!==0&&n.uint32(50).bytes(e.iv),e.hmac!==void 0&&e.hmac.length!==0&&n.uint32(58).bytes(e.hmac),e.reverseProxyConfig!==void 0&&e.reverseProxyConfig!==\"\"&&n.uint32(74).string(e.reverseProxyConfig),e.serializeResponseAsJson!==void 0&&e.serializeResponseAsJson!==!1&&n.uint32(80).bool(e.serializeResponseAsJson),e.enableAdPlacementsPreroll!==void 0&&e.enableAdPlacementsPreroll!==!1&&n.uint32(104).bool(e.enableAdPlacementsPreroll),e.enableCompression!==void 0&&e.enableCompression!==!1&&n.uint32(112).bool(e.enableCompression),e.ustreamerFlags!==void 0&&ne.encode(e.ustreamerFlags,n.uint32(122).fork()).join(),e.unencryptedOnesieInnertubeRequest!==void 0&&e.unencryptedOnesieInnertubeRequest.length!==0&&n.uint32(130).bytes(e.unencryptedOnesieInnertubeRequest),e.useJsonformatterToParsePlayerResponse!==void 0&&e.useJsonformatterToParsePlayerResponse!==!1&&n.uint32(136).bool(e.useJsonformatterToParsePlayerResponse),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=Dn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==10)break;o.context=t.bytes();continue}case 2:{if(i!==18)break;o.encryptedOnesieInnertubeRequest=t.bytes();continue}case 5:{if(i!==42)break;o.encryptedClientKey=t.bytes();continue}case 6:{if(i!==50)break;o.iv=t.bytes();continue}case 7:{if(i!==58)break;o.hmac=t.bytes();continue}case 9:{if(i!==74)break;o.reverseProxyConfig=t.string();continue}case 10:{if(i!==80)break;o.serializeResponseAsJson=t.bool();continue}case 13:{if(i!==104)break;o.enableAdPlacementsPreroll=t.bool();continue}case 14:{if(i!==112)break;o.enableCompression=t.bool();continue}case 15:{if(i!==122)break;o.ustreamerFlags=ne.decode(t,t.uint32());continue}case 16:{if(i!==130)break;o.unencryptedOnesieInnertubeRequest=t.bytes();continue}case 17:{if(i!==136)break;o.useJsonformatterToParsePlayerResponse=t.bool();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function gn(){return{sendVideoPlaybackConfig:!1}}var ne={encode(e,n=new s){return e.sendVideoPlaybackConfig!==void 0&&e.sendVideoPlaybackConfig!==!1&&n.uint32(16).bool(e.sendVideoPlaybackConfig),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=gn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 2:{if(i!==16)break;o.sendVideoPlaybackConfig=t.bool();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function Un(){return{token:\"\"}}var O={encode(e,n=new s){return e.token!==void 0&&e.token!==\"\"&&n.uint32(10).string(e.token),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=Un();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==10)break;o.token=t.string();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function wn(){return{reloadPlaybackParams:void 0}}var ie={encode(e,n=new s){return e.reloadPlaybackParams!==void 0&&O.encode(e.reloadPlaybackParams,n.uint32(10).fork()).join(),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=wn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==10)break;o.reloadPlaybackParams=O.decode(t,t.uint32());continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function Fn(){return{urls:[],clientAbrState:void 0,innertubeRequest:void 0,onesieUstreamerConfig:new Uint8Array(0),maxVp9Height:0,clientDisplayHeight:0,streamerContext:void 0,requestTarget:0,bufferedRanges:[],reloadPlaybackParams:void 0}}var _t={encode(e,n=new s){for(let t of e.urls)n.uint32(10).string(t);e.clientAbrState!==void 0&&C.encode(e.clientAbrState,n.uint32(18).fork()).join(),e.innertubeRequest!==void 0&&F.encode(e.innertubeRequest,n.uint32(26).fork()).join(),e.onesieUstreamerConfig!==void 0&&e.onesieUstreamerConfig.length!==0&&n.uint32(34).bytes(e.onesieUstreamerConfig),e.maxVp9Height!==void 0&&e.maxVp9Height!==0&&n.uint32(40).int32(e.maxVp9Height),e.clientDisplayHeight!==void 0&&e.clientDisplayHeight!==0&&n.uint32(48).int32(e.clientDisplayHeight),e.streamerContext!==void 0&&P.encode(e.streamerContext,n.uint32(82).fork()).join(),e.requestTarget!==void 0&&e.requestTarget!==0&&n.uint32(104).int32(e.requestTarget);for(let t of e.bufferedRanges)S.encode(t,n.uint32(114).fork()).join();return e.reloadPlaybackParams!==void 0&&O.encode(e.reloadPlaybackParams,n.uint32(122).fork()).join(),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=Fn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==10)break;o.urls.push(t.string());continue}case 2:{if(i!==18)break;o.clientAbrState=C.decode(t,t.uint32());continue}case 3:{if(i!==26)break;o.innertubeRequest=F.decode(t,t.uint32());continue}case 4:{if(i!==34)break;o.onesieUstreamerConfig=t.bytes();continue}case 5:{if(i!==40)break;o.maxVp9Height=t.int32();continue}case 6:{if(i!==48)break;o.clientDisplayHeight=t.int32();continue}case 10:{if(i!==82)break;o.streamerContext=P.decode(t,t.uint32());continue}case 13:{if(i!==104)break;o.requestTarget=t.int32();continue}case 14:{if(i!==114)break;o.bufferedRanges.push(S.decode(t,t.uint32()));continue}case 15:{if(i!==122)break;o.reloadPlaybackParams=O.decode(t,t.uint32());continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function vn(){return{type:0,videoId:\"\",itag:\"\",cryptoParams:void 0,lastModified:\"0\",expectedMediaSizeBytes:\"0\",restrictedFormats:[],xtags:\"\",sequenceNumber:\"0\",field23:void 0,field34:void 0}}var It={encode(e,n=new s){e.type!==void 0&&e.type!==0&&n.uint32(8).int32(e.type),e.videoId!==void 0&&e.videoId!==\"\"&&n.uint32(18).string(e.videoId),e.itag!==void 0&&e.itag!==\"\"&&n.uint32(26).string(e.itag),e.cryptoParams!==void 0&&w.encode(e.cryptoParams,n.uint32(34).fork()).join(),e.lastModified!==void 0&&e.lastModified!==\"0\"&&n.uint32(40).uint64(e.lastModified),e.expectedMediaSizeBytes!==void 0&&e.expectedMediaSizeBytes!==\"0\"&&n.uint32(56).int64(e.expectedMediaSizeBytes);for(let t of e.restrictedFormats)n.uint32(90).string(t);return e.xtags!==void 0&&e.xtags!==\"\"&&n.uint32(122).string(e.xtags),e.sequenceNumber!==void 0&&e.sequenceNumber!==\"0\"&&n.uint32(144).int64(e.sequenceNumber),e.field23!==void 0&&St.encode(e.field23,n.uint32(186).fork()).join(),e.field34!==void 0&&Rt.encode(e.field34,n.uint32(274).fork()).join(),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=vn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==8)break;o.type=t.int32();continue}case 2:{if(i!==18)break;o.videoId=t.string();continue}case 3:{if(i!==26)break;o.itag=t.string();continue}case 4:{if(i!==34)break;o.cryptoParams=w.decode(t,t.uint32());continue}case 5:{if(i!==40)break;o.lastModified=t.uint64().toString();continue}case 7:{if(i!==56)break;o.expectedMediaSizeBytes=t.int64().toString();continue}case 11:{if(i!==90)break;o.restrictedFormats.push(t.string());continue}case 15:{if(i!==122)break;o.xtags=t.string();continue}case 18:{if(i!==144)break;o.sequenceNumber=t.int64().toString();continue}case 23:{if(i!==186)break;o.field23=St.decode(t,t.uint32());continue}case 34:{if(i!==274)break;o.field34=Rt.decode(t,t.uint32());continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function Hn(){return{videoId:\"\"}}var St={encode(e,n=new s){return e.videoId!==void 0&&e.videoId!==\"\"&&n.uint32(18).string(e.videoId),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=Hn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 2:{if(i!==18)break;o.videoId=t.string();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function Kn(){return{itagDenylist:[]}}var Rt={encode(e,n=new s){for(let t of e.itagDenylist)n.uint32(10).string(t);return n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=Kn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==10)break;o.itagDenylist.push(t.string());continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};var kt={ONESIE_PLAYER_RESPONSE:0,0:\"ONESIE_PLAYER_RESPONSE\",MEDIA:1,1:\"MEDIA\",MEDIA_DECRYPTION_KEY:2,2:\"MEDIA_DECRYPTION_KEY\",CLEAR_MEDIA:3,3:\"CLEAR_MEDIA\",CLEAR_INIT_SEGMENT:4,4:\"CLEAR_INIT_SEGMENT\",ACK:5,5:\"ACK\",MEDIA_STREAMER_HOSTNAME:6,6:\"MEDIA_STREAMER_HOSTNAME\",MEDIA_SIZE_HINT:7,7:\"MEDIA_SIZE_HINT\",PLAYER_SERVICE_RESPONSE_PUSH_URL:8,8:\"PLAYER_SERVICE_RESPONSE_PUSH_URL\",LAST_HIGH_PRIORITY_HINT:9,9:\"LAST_HIGH_PRIORITY_HINT\",STREAM_METADATA:16,16:\"STREAM_METADATA\",ENCRYPTED_INNERTUBE_RESPONSE_PART:25,25:\"ENCRYPTED_INNERTUBE_RESPONSE_PART\",UNRECOGNIZED:-1,\"-1\":\"UNRECOGNIZED\"};function Vn(){return{url:\"\",headers:[],body:\"\",proxiedByTrustedBandaid:!1,skipResponseEncryption:!1}}var Tt={encode(e,n=new s){e.url!==void 0&&e.url!==\"\"&&n.uint32(10).string(e.url);for(let t of e.headers)N.encode(t,n.uint32(18).fork()).join();return e.body!==void 0&&e.body!==\"\"&&n.uint32(26).string(e.body),e.proxiedByTrustedBandaid!==void 0&&e.proxiedByTrustedBandaid!==!1&&n.uint32(32).bool(e.proxiedByTrustedBandaid),e.skipResponseEncryption!==void 0&&e.skipResponseEncryption!==!1&&n.uint32(48).bool(e.skipResponseEncryption),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=Vn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==10)break;o.url=t.string();continue}case 2:{if(i!==18)break;o.headers.push(N.decode(t,t.uint32()));continue}case 3:{if(i!==26)break;o.body=t.string();continue}case 4:{if(i!==32)break;o.proxiedByTrustedBandaid=t.bool();continue}case 6:{if(i!==48)break;o.skipResponseEncryption=t.bool();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function Wn(){return{onesieProxyStatus:0,httpStatus:0,headers:[],body:new Uint8Array(0)}}var At={encode(e,n=new s){e.onesieProxyStatus!==void 0&&e.onesieProxyStatus!==0&&n.uint32(8).int32(e.onesieProxyStatus),e.httpStatus!==void 0&&e.httpStatus!==0&&n.uint32(16).int32(e.httpStatus);for(let t of e.headers)N.encode(t,n.uint32(26).fork()).join();return e.body!==void 0&&e.body.length!==0&&n.uint32(34).bytes(e.body),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=Wn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==8)break;o.onesieProxyStatus=t.int32();continue}case 2:{if(i!==16)break;o.httpStatus=t.int32();continue}case 3:{if(i!==26)break;o.headers.push(N.decode(t,t.uint32()));continue}case 4:{if(i!==34)break;o.body=t.bytes();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};var yt={UNKNOWN:0,0:\"UNKNOWN\",OK:1,1:\"OK\",DECRYPTION_FAILED:2,2:\"DECRYPTION_FAILED\",PARSING_FAILED:3,3:\"PARSING_FAILED\",MISSING_X_FORWARDED_FOR:4,4:\"MISSING_X_FORWARDED_FOR\",INVALID_X_FORWARDED_FOR:5,5:\"INVALID_X_FORWARDED_FOR\",INVALID_CONTENT_TYPE:6,6:\"INVALID_CONTENT_TYPE\",BACKEND_ERROR:7,7:\"BACKEND_ERROR\",CLIENT_ERROR:8,8:\"CLIENT_ERROR\",MISSING_CRYPTER:9,9:\"MISSING_CRYPTER\",RESPONSE_JSON_SERIALIZATION_FAILED:10,10:\"RESPONSE_JSON_SERIALIZATION_FAILED\",DECOMPRESSION_FAILED:11,11:\"DECOMPRESSION_FAILED\",JSON_PARSING_FAILED:12,12:\"JSON_PARSING_FAILED\",UNKNOWN_COMPRESSION_TYPE:13,13:\"UNKNOWN_COMPRESSION_TYPE\",UNRECOGNIZED:-1,\"-1\":\"UNRECOGNIZED\"};var oe={UNSPECIFIED:0,0:\"UNSPECIFIED\",OVERWRITE:1,1:\"OVERWRITE\",KEEP_EXISTING:2,2:\"KEEP_EXISTING\",UNRECOGNIZED:-1,\"-1\":\"UNRECOGNIZED\"};function Gn(){return{type:0,scope:0,value:new Uint8Array(0),sendByDefault:!1,writePolicy:0}}var re={encode(e,n=new s){return e.type!==void 0&&e.type!==0&&n.uint32(8).int32(e.type),e.scope!==void 0&&e.scope!==0&&n.uint32(16).int32(e.scope),e.value!==void 0&&e.value.length!==0&&n.uint32(26).bytes(e.value),e.sendByDefault!==void 0&&e.sendByDefault!==!1&&n.uint32(32).bool(e.sendByDefault),e.writePolicy!==void 0&&e.writePolicy!==0&&n.uint32(40).int32(e.writePolicy),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=Gn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==8)break;o.type=t.int32();continue}case 2:{if(i!==16)break;o.scope=t.int32();continue}case 3:{if(i!==26)break;o.value=t.bytes();continue}case 4:{if(i!==32)break;o.sendByDefault=t.bool();continue}case 5:{if(i!==40)break;o.writePolicy=t.int32();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function Yn(){return{timing:void 0,signature:new Uint8Array(0),field5:0}}var Pt={encode(e,n=new s){return e.timing!==void 0&&Ct.encode(e.timing,n.uint32(10).fork()).join(),e.signature!==void 0&&e.signature.length!==0&&n.uint32(18).bytes(e.signature),e.field5!==void 0&&e.field5!==0&&n.uint32(40).int32(e.field5),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=Yn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==10)break;o.timing=Ct.decode(t,t.uint32());continue}case 2:{if(i!==18)break;o.signature=t.bytes();continue}case 5:{if(i!==40)break;o.field5=t.int32();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function qn(){return{contentId:\"\",contentType:0}}var Nt={encode(e,n=new s){return e.contentId!==void 0&&e.contentId!==\"\"&&n.uint32(10).string(e.contentId),e.contentType!==void 0&&e.contentType!==0&&n.uint32(16).int32(e.contentType),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=qn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==10)break;o.contentId=t.string();continue}case 2:{if(i!==16)break;o.contentType=t.int32();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function zn(){return{timestampMs:\"0\",durationMs:0,content:void 0}}var Ct={encode(e,n=new s){return e.timestampMs!==void 0&&e.timestampMs!==\"0\"&&n.uint32(8).int64(e.timestampMs),e.durationMs!==void 0&&e.durationMs!==0&&n.uint32(16).int32(e.durationMs),e.content!==void 0&&Nt.encode(e.content,n.uint32(26).fork()).join(),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=zn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==8)break;o.timestampMs=t.int64().toString();continue}case 2:{if(i!==16)break;o.durationMs=t.int32();continue}case 3:{if(i!==26)break;o.content=Nt.decode(t,t.uint32());continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function $n(){return{startPolicy:[],stopPolicy:[],discardPolicy:[]}}var ae={encode(e,n=new s){n.uint32(10).fork();for(let t of e.startPolicy)n.int32(t);n.join(),n.uint32(18).fork();for(let t of e.stopPolicy)n.int32(t);n.join(),n.uint32(26).fork();for(let t of e.discardPolicy)n.int32(t);return n.join(),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=$n();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i===8){o.startPolicy.push(t.int32());continue}if(i===10){let d=t.uint32()+t.pos;for(;t.pos<d;)o.startPolicy.push(t.int32());continue}break}case 2:{if(i===16){o.stopPolicy.push(t.int32());continue}if(i===18){let d=t.uint32()+t.pos;for(;t.pos<d;)o.stopPolicy.push(t.int32());continue}break}case 3:{if(i===24){o.discardPolicy.push(t.int32());continue}if(i===26){let d=t.uint32()+t.pos;for(;t.pos<d;)o.discardPolicy.push(t.int32());continue}break}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function jn(){return{status:0,maxRetries:0}}var de={encode(e,n=new s){return e.status!==void 0&&e.status!==0&&n.uint32(8).int32(e.status),e.maxRetries!==void 0&&e.maxRetries!==0&&n.uint32(16).int32(e.maxRetries),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=jn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==8)break;o.status=t.int32();continue}case 2:{if(i!==16)break;o.maxRetries=t.int32();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function Qn(){return{broadcastId:\"\",headSequenceNumber:\"0\",headTimeMs:\"0\",wallTimeMs:\"0\",videoId:\"\",postLiveDvr:!1,headm:\"0\",minSeekableTimeTicks:\"0\",minSeekableTimescale:0,maxSeekableTimeTicks:\"0\",maxSeekableTimescale:0}}var mt={encode(e,n=new s){return e.broadcastId!==void 0&&e.broadcastId!==\"\"&&n.uint32(10).string(e.broadcastId),e.headSequenceNumber!==void 0&&e.headSequenceNumber!==\"0\"&&n.uint32(24).int64(e.headSequenceNumber),e.headTimeMs!==void 0&&e.headTimeMs!==\"0\"&&n.uint32(32).int64(e.headTimeMs),e.wallTimeMs!==void 0&&e.wallTimeMs!==\"0\"&&n.uint32(40).int64(e.wallTimeMs),e.videoId!==void 0&&e.videoId!==\"\"&&n.uint32(50).string(e.videoId),e.postLiveDvr!==void 0&&e.postLiveDvr!==!1&&n.uint32(64).bool(e.postLiveDvr),e.headm!==void 0&&e.headm!==\"0\"&&n.uint32(80).int64(e.headm),e.minSeekableTimeTicks!==void 0&&e.minSeekableTimeTicks!==\"0\"&&n.uint32(96).int64(e.minSeekableTimeTicks),e.minSeekableTimescale!==void 0&&e.minSeekableTimescale!==0&&n.uint32(104).int32(e.minSeekableTimescale),e.maxSeekableTimeTicks!==void 0&&e.maxSeekableTimeTicks!==\"0\"&&n.uint32(112).int64(e.maxSeekableTimeTicks),e.maxSeekableTimescale!==void 0&&e.maxSeekableTimescale!==0&&n.uint32(120).int32(e.maxSeekableTimescale),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=Qn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==10)break;o.broadcastId=t.string();continue}case 3:{if(i!==24)break;o.headSequenceNumber=t.int64().toString();continue}case 4:{if(i!==32)break;o.headTimeMs=t.int64().toString();continue}case 5:{if(i!==40)break;o.wallTimeMs=t.int64().toString();continue}case 6:{if(i!==50)break;o.videoId=t.string();continue}case 8:{if(i!==64)break;o.postLiveDvr=t.bool();continue}case 10:{if(i!==80)break;o.headm=t.int64().toString();continue}case 12:{if(i!==96)break;o.minSeekableTimeTicks=t.int64().toString();continue}case 13:{if(i!==104)break;o.minSeekableTimescale=t.int32();continue}case 14:{if(i!==112)break;o.maxSeekableTimeTicks=t.int64().toString();continue}case 15:{if(i!==120)break;o.maxSeekableTimescale=t.int32();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};function Xn(){return{id:0}}var Mt={encode(e,n=new s){return e.id!==void 0&&e.id!==0&&n.uint32(8).int32(e.id),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=Xn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 1:{if(i!==8)break;o.id=t.int32();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};var E={UNKNOWN:0,0:\"UNKNOWN\",ONESIE_HEADER:10,10:\"ONESIE_HEADER\",ONESIE_DATA:11,11:\"ONESIE_DATA\",ONESIE_ENCRYPTED_MEDIA:12,12:\"ONESIE_ENCRYPTED_MEDIA\",MEDIA_HEADER:20,20:\"MEDIA_HEADER\",MEDIA:21,21:\"MEDIA\",MEDIA_END:22,22:\"MEDIA_END\",CONFIG:30,30:\"CONFIG\",LIVE_METADATA:31,31:\"LIVE_METADATA\",HOSTNAME_CHANGE_HINT_DEPRECATED:32,32:\"HOSTNAME_CHANGE_HINT_DEPRECATED\",LIVE_METADATA_PROMISE:33,33:\"LIVE_METADATA_PROMISE\",LIVE_METADATA_PROMISE_CANCELLATION:34,34:\"LIVE_METADATA_PROMISE_CANCELLATION\",NEXT_REQUEST_POLICY:35,35:\"NEXT_REQUEST_POLICY\",USTREAMER_VIDEO_AND_FORMAT_METADATA:36,36:\"USTREAMER_VIDEO_AND_FORMAT_METADATA\",FORMAT_SELECTION_CONFIG:37,37:\"FORMAT_SELECTION_CONFIG\",USTREAMER_SELECTED_MEDIA_STREAM:38,38:\"USTREAMER_SELECTED_MEDIA_STREAM\",FORMAT_INITIALIZATION_METADATA:42,42:\"FORMAT_INITIALIZATION_METADATA\",SABR_REDIRECT:43,43:\"SABR_REDIRECT\",SABR_ERROR:44,44:\"SABR_ERROR\",SABR_SEEK:45,45:\"SABR_SEEK\",RELOAD_PLAYER_RESPONSE:46,46:\"RELOAD_PLAYER_RESPONSE\",PLAYBACK_START_POLICY:47,47:\"PLAYBACK_START_POLICY\",ALLOWED_CACHED_FORMATS:48,48:\"ALLOWED_CACHED_FORMATS\",START_BW_SAMPLING_HINT:49,49:\"START_BW_SAMPLING_HINT\",PAUSE_BW_SAMPLING_HINT:50,50:\"PAUSE_BW_SAMPLING_HINT\",SELECTABLE_FORMATS:51,51:\"SELECTABLE_FORMATS\",REQUEST_IDENTIFIER:52,52:\"REQUEST_IDENTIFIER\",REQUEST_CANCELLATION_POLICY:53,53:\"REQUEST_CANCELLATION_POLICY\",ONESIE_PREFETCH_REJECTION:54,54:\"ONESIE_PREFETCH_REJECTION\",TIMELINE_CONTEXT:55,55:\"TIMELINE_CONTEXT\",REQUEST_PIPELINING:56,56:\"REQUEST_PIPELINING\",SABR_CONTEXT_UPDATE:57,57:\"SABR_CONTEXT_UPDATE\",STREAM_PROTECTION_STATUS:58,58:\"STREAM_PROTECTION_STATUS\",SABR_CONTEXT_SENDING_POLICY:59,59:\"SABR_CONTEXT_SENDING_POLICY\",LAWNMOWER_POLICY:60,60:\"LAWNMOWER_POLICY\",SABR_ACK:61,61:\"SABR_ACK\",END_OF_TRACK:62,62:\"END_OF_TRACK\",CACHE_LOAD_POLICY:63,63:\"CACHE_LOAD_POLICY\",LAWNMOWER_MESSAGING_POLICY:64,64:\"LAWNMOWER_MESSAGING_POLICY\",PREWARM_CONNECTION:65,65:\"PREWARM_CONNECTION\",PLAYBACK_DEBUG_INFO:66,66:\"PLAYBACK_DEBUG_INFO\",SNACKBAR_MESSAGE:67,67:\"SNACKBAR_MESSAGE\",UNRECOGNIZED:-1,\"-1\":\"UNRECOGNIZED\"};function Zn(){return{itags:[],videoId:\"\",resolution:0}}var Ot={encode(e,n=new s){n.uint32(18).fork();for(let t of e.itags)n.int32(t);return n.join(),e.videoId!==void 0&&e.videoId!==\"\"&&n.uint32(26).string(e.videoId),e.resolution!==void 0&&e.resolution!==0&&n.uint32(32).int32(e.resolution),n},decode(e,n){let t=e instanceof a?e:new a(e),r=n===void 0?t.len:t.pos+n,o=Zn();for(;t.pos<r;){let i=t.uint32();switch(i>>>3){case 2:{if(i===16){o.itags.push(t.int32());continue}if(i===18){let d=t.uint32()+t.pos;for(;t.pos<d;)o.itags.push(t.int32());continue}break}case 3:{if(i!==26)break;o.videoId=t.string();continue}case 4:{if(i!==32)break;o.resolution=t.int32();continue}}if((i&7)===4||i===0)break;t.skip(i&7)}return o}};var h={NONE:0,0:\"NONE\",ERROR:1,1:\"ERROR\",WARN:2,2:\"WARN\",INFO:3,3:\"INFO\",DEBUG:4,4:\"DEBUG\",ALL:99,99:\"ALL\"},x=class e{constructor(){this.currentLogLevels=new Set([h.INFO,h.ERROR])}static getInstance(){return e.instance||(e.instance=new e),e.instance}setLogLevels(...n){n.length===0||n.includes(h.NONE)?this.currentLogLevels=new Set:n.includes(h.ALL)?this.currentLogLevels=new Set([h.ERROR,h.WARN,h.INFO,h.DEBUG]):this.currentLogLevels=new Set(n.filter(t=>t!==h.NONE&&t!==h.ALL))}getLogLevels(){return new Set(this.currentLogLevels)}log(n,t,...r){if(n!==h.NONE&&this.currentLogLevels.has(n)){let o=`[${h[n]}] [${t}]`;switch(n){case h.ERROR:console.error(o,...r);break;case h.WARN:console.warn(o,...r);break;case h.INFO:console.info(o,...r);break;case h.DEBUG:console.debug(o,...r);break}}}error(n,...t){this.log(h.ERROR,n,...t)}warn(n,...t){this.log(h.WARN,n,...t)}info(n,...t){this.log(h.INFO,n,...t)}debug(n,...t){this.log(h.DEBUG,n,...t)}};var L=\"2147483647\",Ae={VIDEO_AND_AUDIO:0,0:\"VIDEO_AND_AUDIO\",AUDIO_ONLY:1,1:\"AUDIO_ONLY\",VIDEO_ONLY:2,2:\"VIDEO_ONLY\"};function Jn(e){if(e.startsWith(\"sabr://\"))return!0;let n=e.split(\"?\"),t=n[0],r=n[1]||\"\";if(t.endsWith(\"/videoplayback\")){let o=new URLSearchParams(r);if(o.get(\"source\")===\"youtube\"||o.has(\"sabr\")||o.has(\"lsig\")||o.has(\"expire\"))return!0}else if(t.includes(\"/videoplayback/\")){let o=t.split(\"/\");return[\"videoplayback\",\"sabr\",\"lsig\",\"expire\"].some(i=>o.includes(i))}return!1}function ei(e){if(!e)return;let n=e.split(\"=\")[1]?.split(\"-\");if(n?.length){let t=Number(n[0]),r=Number(n[1]);return{start:t,end:r}}}function ti(e){return btoa(String.fromCharCode.apply(null,Array.from(e)))}function se(e){let n=e.replace(/-/g,\"+\").replace(/_/g,\"/\"),t=n.padEnd(n.length+(4-n.length%4)%4,\"=\");return new Uint8Array(atob(t).split(\"\").map(r=>r.charCodeAt(0)))}function ye(e){let n=e.reduce((o,i)=>o+i.length,0),t=new Uint8Array(n),r=0;for(let o of e)t.set(o,r),r+=o.length;return t}function ni(e){return{itag:e.itag,lastModified:e.last_modified_ms||e.lastModified||\"0\",xtags:e.xtags,width:e.width,height:e.height,mimeType:e.mime_type||e.mimeType,audioQuality:e.audio_quality||e.audioQuality,bitrate:e.bitrate,averageBitrate:e.average_bitrate||e.averageBitrate,quality:e.quality,qualityLabel:e.quality_label||e.qualityLabel,audioTrackId:e.audio_track?.id||e.audioTrackId,approxDurationMs:e.approx_duration_ms||parseInt(e.approxDurationMs||\"0\"),contentLength:parseInt(e.contentLength||\"0\")||e.content_length,isDrc:e.is_drc,isAutoDubbed:e.is_auto_dubbed,isDescriptive:e.is_descriptive,isDubbed:e.is_dubbed,language:e.language,isOriginal:e.is_original,isSecondary:e.is_secondary}}function ce(e){return new Promise(n=>setTimeout(n,e))}var v=\"CacheManager\",Ne=class{constructor(n=50,t=600){this.initSegmentCache=new Map,this.segmentCache=new Map,this.currentSize=0,this.logger=x.getInstance(),this.maxCacheSize=n*1024*1024,this.maxAge=t*1e3,this.startGarbageCollection()}getCacheEntries(){return{initSegmentCache:this.initSegmentCache,segmentCache:this.segmentCache}}setInitSegment(n,t){let r={data:t,timestamp:Date.now(),size:t.byteLength};this.initSegmentCache.has(n)||(this.currentSize+=r.size,this.enforceStorageLimit()),this.initSegmentCache.set(n,r)}setSegment(n,t){let r={data:t,timestamp:Date.now(),size:t.byteLength};this.currentSize+=r.size,this.enforceStorageLimit(),this.segmentCache.set(n,r)}getInitSegment(n){let t=this.initSegmentCache.get(n);if(t&&!this.isExpired(t))return this.logger.debug(v,`Cache hit for init segment: ${n}`),t.timestamp=Date.now(),t.data;t&&(this.initSegmentCache.delete(n),this.currentSize-=t.size)}getSegment(n){let t=this.segmentCache.get(n);if(t&&!this.isExpired(t)){this.logger.debug(v,`Cache hit for segment: ${n}`);let r=t.data;return this.segmentCache.delete(n),this.currentSize-=t.size,r}t&&(this.segmentCache.delete(n),this.currentSize-=t.size)}isExpired(n){return Date.now()-n.timestamp>this.maxAge}enforceStorageLimit(){this.currentSize<=this.maxCacheSize||(this.clearExpiredEntries(),this.currentSize>this.maxCacheSize&&this.removeOldestEntries())}clearExpiredEntries(){let n=Date.now();for(let[t,r]of this.segmentCache.entries())n-r.timestamp>this.maxAge&&(this.logger.debug(v,`Removing expired segment from cache: ${t}`),this.segmentCache.delete(t),this.currentSize-=r.size);for(let[t,r]of this.initSegmentCache.entries())n-r.timestamp>this.maxAge&&(this.logger.debug(v,`Removing expired init segment from cache: ${t}`),this.initSegmentCache.delete(t),this.currentSize-=r.size)}removeOldestEntries(){let n=Array.from(this.segmentCache.entries()),t=Array.from(this.initSegmentCache.entries()),r=[...n,...t].sort((o,i)=>o[1].timestamp-i[1].timestamp);for(;this.currentSize>this.maxCacheSize&&r.length>0;){let[o,i]=r.shift();this.segmentCache.delete(o),this.initSegmentCache.delete(o),this.currentSize-=i.size}}startGarbageCollection(){this.timerId=setInterval(()=>{this.clearExpiredEntries()},6e4)}dispose(){this.initSegmentCache.clear(),this.segmentCache.clear(),this.currentSize=0,this.timerId&&(clearInterval(this.timerId),this.timerId=void 0),this.logger.debug(v,\"Disposed\")}};var ii=function(e,n,t,r,o){if(r===\"m\")throw new TypeError(\"Private method is not writable\");if(r===\"a\"&&!o)throw new TypeError(\"Private accessor was defined without a setter\");if(typeof n==\"function\"?e!==n||!o:!n.has(e))throw new TypeError(\"Cannot write private member to an object whose class did not declare it\");return r===\"a\"?o.call(e,t):o?o.value=t:n.set(e,t),t},A=function(e,n,t,r){if(t===\"a\"&&!r)throw new TypeError(\"Private accessor was defined without a getter\");if(typeof n==\"function\"?e!==n||!r:!n.has(e))throw new TypeError(\"Cannot read private member from an object whose class did not declare it\");return t===\"m\"?r:t===\"a\"?r.call(e):r?r.value:n.get(e)},ue,R,H=class extends Event{constructor(n,t){super(n,t),ue.set(this,void 0),ii(this,ue,t?.detail??null,\"f\")}get detail(){return A(this,ue,\"f\")}};ue=new WeakMap;var Ce=class extends Error{constructor(n,t){super(`[SabrStreamingAdapter] ${n}`),this.code=t,this.name=\"SabrAdapterError\"}},K=class extends EventTarget{constructor(){super(),R.set(this,new Map)}emit(n,...t){let r=new H(n,{detail:t});this.dispatchEvent(r)}on(n,t){let r=o=>{o instanceof H?t(...o.detail):t(o)};A(this,R,\"f\").set(t,{type:n,wrapper:r}),this.addEventListener(n,r)}once(n,t){let r=o=>{o instanceof H?t(...o.detail):t(o),this.off(n,t)};A(this,R,\"f\").set(t,{type:n,wrapper:r}),this.addEventListener(n,r)}off(n,t){let r=A(this,R,\"f\").get(t);r&&r.type===n&&(this.removeEventListener(n,r.wrapper),A(this,R,\"f\").delete(t))}removeAllListeners(n){if(n)for(let[t,r]of A(this,R,\"f\").entries())r.type===n&&(this.removeEventListener(n,r.wrapper),A(this,R,\"f\").delete(t));else for(let[t,r]of A(this,R,\"f\").entries())this.removeEventListener(r.type,r.wrapper),A(this,R,\"f\").delete(t)}};R=new WeakMap;var Pe=class{constructor(){this.CLEANUP_INTERVAL=3e4,this.ENTRY_EXPIRATION_TIME=1e3*60*3,this.metadataMap=new Map,this.lastCleanup=Date.now()}getRequestMetadata(n,t=!1){let r=new URL(n).searchParams.get(\"rn\")||\"\",o=this.metadataMap.get(r);if(o&&Date.now()-o.timestamp>this.ENTRY_EXPIRATION_TIME){this.metadataMap.delete(r);return}return t&&this.metadataMap.delete(r),this.conditionalCleanUp(),o}setRequestMetadata(n,t){let r=new URL(n).searchParams.get(\"rn\");r&&(this.metadataMap.set(r,t),this.conditionalCleanUp())}conditionalCleanUp(){let n=Date.now();n-this.lastCleanup>this.CLEANUP_INTERVAL&&(this.cleanUp(),this.lastCleanup=n)}cleanUp(){for(let[n,t]of this.metadataMap.entries())Date.now()-t.timestamp>this.ENTRY_EXPIRATION_TIME&&this.metadataMap.delete(n)}};var he={};B(he,{createKey:()=>fe,createSegmentCacheKey:()=>xt,createSegmentCacheKeyFromMetadata:()=>oi,fromFormat:()=>_,fromFormatInitializationMetadata:()=>le,fromMediaHeader:()=>me,getUniqueFormatId:()=>ri});function fe(e,n){return`${e||\"\"}:${n||\"\"}`}function _(e){if(e)return fe(e.itag,e.xtags)}function me(e){return fe(e.itag,e.xtags)}function le(e){return e.formatId?fe(e.formatId.itag,e.formatId.xtags):\"\"}function xt(e,n){return e.isInitSeg&&n?`${e.itag}:${e.xtags||\"\"}:${n.contentLength||\"\"}:${n.mimeType||\"\"}`:`${e.startRange||\"0\"}-${e.itag}-${e.xtags||\"\"}`}function oi(e){if(!e.byteRange||!e.format)throw new Error(\"Invalid metadata: byteRange or format is missing\");let n={itag:e.format.itag,xtags:e.format.xtags||\"\",startRange:e.byteRange.start.toString(),isInitSeg:e.isInit};return xt(n,e.isInit?e.format:void 0)}function ri(e){if(e.width)return e.itag.toString();let n=[e.itag.toString()];return e.audioTrackId&&n.push(e.audioTrackId),e.isDrc&&n.push(\"drc\"),n.join(\"-\")}function Oe(e){return e.formatInitializationMetadata?.mimeType?.includes(\"video\")?\"video\":\"audio\"}function pe(e){return Array.from(e.downloadedSegments.values()).reduce((n,t)=>n+parseInt(t.durationMs||\"0\"),0)}function ai(e,n){return e.filter(t=>t.mimeType?n?t.mimeType.includes(\"audio\"):t.mimeType.includes(\"video\"):!1)}function xe(e,n,t){if(!e.length)return;let r=ai(e,t.isAudio);if(!r.length)return;if(typeof n==\"number\")return r.find(i=>i.itag===n);if(n&&typeof n!=\"function\")return n;if(typeof n==\"function\")return n(r);let o=r;return t.language&&(o=o.filter(i=>i.language===t.language)),t.quality&&(o=o.filter(i=>t.isAudio?!!i.audioQuality?.toLowerCase().includes(t.quality?.toLowerCase()||\"\"):!!i.qualityLabel?.toLowerCase().includes(t.quality?.toLowerCase()||\"\"))),t.isAudio?t.preferOpus&&(o=Me(o,\"opus\")):t.preferH264&&(o=o.filter(i=>!!i.mimeType&&i.mimeType.includes(\"mp4\")&&i.mimeType.includes(\"avc\"))),t.preferWebM?o=Me(o,\"webm\"):t.preferMP4&&(o=Me(o,\"mp4\")),t.isAudio?o.sort((i,d)=>(d.bitrate||0)-(i.bitrate||0))[0]:o.sort((i,d)=>(d.height||0)-(i.height||0))[0]}function Me(e,n){return e.filter(t=>t.mimeType?.includes(n))}var V=class e{constructor(n=[]){this.chunks=[],this.currentChunkOffset=this.currentChunkIndex=0,this.currentDataView=void 0,this.totalLength=0,n.forEach(t=>this.append(t))}append(n){if(n instanceof Uint8Array){if(this.canMergeWithLastChunk(n)){let t=this.chunks[this.chunks.length-1];this.chunks[this.chunks.length-1]=new Uint8Array(t.buffer,t.byteOffset,t.length+n.length),this.resetFocus()}else this.chunks.push(n);this.totalLength+=n.length}else n.chunks.forEach(t=>this.append(t))}split(n){let t=new e,r=new e,o=this.chunks[Symbol.iterator](),i=o.next();for(;!i.done;){let d=i.value;n>=d.length?(t.append(d),n-=d.length):n>0?(t.append(new Uint8Array(d.buffer,d.byteOffset,n)),r.append(new Uint8Array(d.buffer,d.byteOffset+n,d.length-n)),n=0):r.append(d),i=o.next()}return{extractedBuffer:t,remainingBuffer:r}}getLength(){return this.totalLength}canReadBytes(n,t){return n+t<=this.totalLength}getUint8(n){return this.focus(n),this.chunks[this.currentChunkIndex][n-this.currentChunkOffset]}focus(n){if(!this.isFocused(n)){for(n<this.currentChunkOffset&&this.resetFocus();this.currentChunkOffset+this.chunks[this.currentChunkIndex].length<=n&&this.currentChunkIndex<this.chunks.length-1;)this.currentChunkOffset+=this.chunks[this.currentChunkIndex].length,this.currentChunkIndex+=1;this.currentDataView=void 0}}isFocused(n){return n>=this.currentChunkOffset&&n<this.currentChunkOffset+this.chunks[this.currentChunkIndex].length}resetFocus(){this.currentDataView=void 0,this.currentChunkIndex=0,this.currentChunkOffset=0}canMergeWithLastChunk(n){if(this.chunks.length===0)return!1;let t=this.chunks[this.chunks.length-1];return t.buffer===n.buffer&&t.byteOffset+t.length===n.byteOffset}};var W=class{constructor(n){this.compositeBuffer=n}read(n){for(;;){let t=0,[r,o]=this.readVarInt(t);t=o;let[i,d]=this.readVarInt(t);if(t=d,r<0||i<0)break;if(!this.compositeBuffer.canReadBytes(t,i)){if(!this.compositeBuffer.canReadBytes(t,1))break;return{type:r,size:i,data:this.compositeBuffer}}let c=this.compositeBuffer.split(t).remainingBuffer.split(i);t=0,n({type:r,size:i,data:c.extractedBuffer}),this.compositeBuffer=c.remainingBuffer}}readVarInt(n){let t;if(this.compositeBuffer.canReadBytes(n,1)){let o=this.compositeBuffer.getUint8(n);t=o<128?1:o<192?2:o<224?3:o<240?4:5}else t=0;if(t<1||!this.compositeBuffer.canReadBytes(n,t))return[-1,n];let r;switch(t){case 1:r=this.compositeBuffer.getUint8(n++);break;case 2:{let o=this.compositeBuffer.getUint8(n++),i=this.compositeBuffer.getUint8(n++);r=(o&63)+64*i;break}case 3:{let o=this.compositeBuffer.getUint8(n++),i=this.compositeBuffer.getUint8(n++),d=this.compositeBuffer.getUint8(n++);r=(o&31)+32*(i+256*d);break}case 4:{let o=this.compositeBuffer.getUint8(n++),i=this.compositeBuffer.getUint8(n++),d=this.compositeBuffer.getUint8(n++),c=this.compositeBuffer.getUint8(n++);r=(o&15)+16*(i+256*(d+256*c));break}default:{let o=n+1;if(this.compositeBuffer.focus(o),this.canReadFromCurrentChunk(o,4))r=this.getCurrentDataView().getUint32(o-this.compositeBuffer.currentChunkOffset,!0);else{let i=this.compositeBuffer.getUint8(o+2)+256*this.compositeBuffer.getUint8(o+3);r=this.compositeBuffer.getUint8(o)+256*(this.compositeBuffer.getUint8(o+1)+256*i)}n+=5;break}}return[r,n]}canReadFromCurrentChunk(n,t){return n-this.compositeBuffer.currentChunkOffset+t<=this.compositeBuffer.chunks[this.compositeBuffer.currentChunkIndex].length}getCurrentDataView(){if(!this.compositeBuffer.currentDataView){let n=this.compositeBuffer.chunks[this.compositeBuffer.currentChunkIndex];this.compositeBuffer.currentDataView=new DataView(n.buffer,n.byteOffset,n.length)}return this.compositeBuffer.currentDataView}};var f=\"SabrStream\",di=10,si=8e3,ci=500,ui=3e4,Bt=5,Be=class extends K{on(n,t){super.on(n,t)}once(n,t){super.once(n,t)}constructor(n={}){super(),this.logger=x.getInstance(),this.formatIds=[],this.umpPartHandlers=new Map([[E.FORMAT_INITIALIZATION_METADATA,this.handleFormatInitializationMetadata.bind(this)],[E.NEXT_REQUEST_POLICY,this.handleNextRequestPolicy.bind(this)],[E.SABR_ERROR,this.handleSabrError.bind(this)],[E.SABR_REDIRECT,this.handleSabrRedirect.bind(this)],[E.SABR_CONTEXT_UPDATE,this.handleSabrContextUpdate.bind(this)],[E.SABR_CONTEXT_SENDING_POLICY,this.handleSabrContextSendingPolicy.bind(this)],[E.STREAM_PROTECTION_STATUS,this.handleStreamProtectionStatus.bind(this)],[E.RELOAD_PLAYER_RESPONSE,this.handleReloadPlayerResponse.bind(this)],[E.MEDIA_HEADER,this.handleMediaHeader.bind(this)],[E.MEDIA,this.handleMedia.bind(this)],[E.MEDIA_END,this.handleMediaEnd.bind(this)]]),this.sabrContexts=new Map,this.activeSabrContextTypes=new Set,this.initializedFormatsMap=new Map,this.partialSegmentQueue=new Map,this.requestNumber=0,this.durationMs=1/0,this.mediaHeadersProcessed=!1,this._errored=!1,this._aborted=!1,this.progressTracker={lastProgressTime:Date.now(),lastDownloadedDuration:0,stallCount:0},this.fetchFunction=n?.fetch||fetch,this.serverAbrStreamingUrl=n.serverAbrStreamingUrl,this.videoPlaybackUstreamerConfig=n.videoPlaybackUstreamerConfig,this.clientInfo=n.clientInfo,this.poToken=n.poToken,this.durationMs=n.durationMs||1/0,this.formatIds=n.formats||[],this.videoStream=new ReadableStream({start:t=>{this.videoController=t}}),this.audioStream=new ReadableStream({start:t=>{this.audioController=t}})}setPoToken(n){this.poToken=n}setServerAbrFormats(n){this.formatIds.push(...n)}setDurationMs(n){this.durationMs=n}setStreamingURL(n){this.serverAbrStreamingUrl=n}setUstreamerConfig(n){this.videoPlaybackUstreamerConfig=n}setClientInfo(n){this.clientInfo=n}abort(){this.logger.debug(f,\"Aborting download process\"),this._aborted=!0,this.abortController?.abort(),this.videoController?.error(new Error(\"Download aborted.\")),this.audioController?.error(new Error(\"Download aborted.\")),this.resetState(),this.emit(\"abort\")}getState(){if(!this.mainFormat)throw new Error(\"Main format is not initialized, cannot get state.\");let n=pe(this.mainFormat),t=[];for(let[r,o]of this.initializedFormatsMap.entries())t.push({formatKey:r,formatInitializationMetadata:o.formatInitializationMetadata,downloadedSegments:Array.from(o.downloadedSegments.entries()),lastMediaHeaders:o.lastMediaHeaders});return{durationMs:this.durationMs,requestNumber:this.requestNumber,activeSabrContexts:Array.from(this.activeSabrContextTypes),sabrContextUpdates:Array.from(this.sabrContexts.entries()),formatToDiscard:this.formatToDiscard,cachedBufferedRanges:this.cachedBufferedRanges||[],nextRequestPolicy:this.nextRequestPolicy,initializedFormats:t,playerTimeMs:n}}async start(n){let{videoFormat:t,audioFormat:r}=this.selectFormats(n);return this.setupStreamingProcess(t,r,n).then(),{videoStream:this.videoStream,audioStream:this.audioStream,selectedFormats:{videoFormat:t,audioFormat:r}}}async setupStreamingProcess(n,t,r){try{this._errored=!1,this._aborted=!1;let o=0;r.state&&this.restoreState(n,t,r.state)&&(o=r.state.playerTimeMs||0);let i=r.maxRetries!==void 0?r.maxRetries:di,d=r.enabledTrackTypes??Ae.VIDEO_AND_AUDIO,c={playerTimeMs:o,audioTrackId:t.audioTrackId,playbackRate:1,stickyResolution:n.height||360,drcEnabled:t.isDrc,clientViewportIsFlexible:!1,visibility:1,enabledTrackTypesBitfield:d};for((c.enabledTrackTypesBitfield===1||c.enabledTrackTypesBitfield===2)&&(this.formatToDiscard=c.enabledTrackTypesBitfield===1?_(n):_(t));parseInt(c.playerTimeMs)<this.durationMs;){if(this._aborted){this.logger.debug(f,\"Download process aborted, exiting streaming loop.\");break}this.logger.debug(f,`Starting new segment fetch at playback position: ${c.playerTimeMs}ms`),this.mainFormat=c.enabledTrackTypesBitfield===1?this.initializedFormatsMap.get(_(t)||\"\"):this.initializedFormatsMap.get(_(n)||\"\"),this.mainFormat&&this.validateAndCorrectDuration(this.mainFormat.formatInitializationMetadata),c.playerTimeMs=this.mainFormat?pe(this.mainFormat):0;let{shouldStop:u}=this.checkForStall({playerTimeMs:c.playerTimeMs,stallDetectionMs:r.stallDetectionMs});if(u||(c.playerTimeMs=c.playerTimeMs.toString(),!await this.executeWithRetry(()=>this.fetchAndProcessSegments(c,t,n),i)))break}}catch(o){this._aborted||this.errorHandler(o,!0)}finally{this._aborted||(this.validateDownloadedSegments(),this._errored||(this.videoController?.close(),this.audioController?.close()),this.resetState(),this.emit(\"finish\"))}}restoreState(n,t,r){if(this.resetState(),!r||typeof r!=\"object\"||!r.initializedFormats||!Array.isArray(r.initializedFormats)||!r.durationMs||!r.playerTimeMs)return this.logger.warn(f,\"Invalid or corrupt state object provided. Starting fresh.\"),!1;let o=_(n)||\"\",i=_(t)||\"\";for(let d of r.initializedFormats){let{formatKey:c,formatInitializationMetadata:u,downloadedSegments:I,lastMediaHeaders:k}=d;if(c!==o&&c!==i){this.logger.warn(f,`State contains an unexpected format key \"${c}\". It will be ignored.`);continue}this.initializedFormatsMap.set(c,{formatInitializationMetadata:u,downloadedSegments:new Map(I),lastMediaHeaders:k||[]})}return!this.initializedFormatsMap.has(o)||!this.initializedFormatsMap.has(i)?(this.logger.warn(f,\"State is missing required format data for the selected video/audio formats. Starting fresh.\"),this.resetState(),!1):(this.durationMs=r.durationMs,this.requestNumber=r.requestNumber||0,this.activeSabrContextTypes=new Set(r.activeSabrContexts||[]),this.sabrContexts=new Map(r.sabrContextUpdates||[]),this.formatToDiscard=r.formatToDiscard,this.cachedBufferedRanges=r.cachedBufferedRanges||[],this.nextRequestPolicy=r.nextRequestPolicy,!0)}checkForStall(n){let t=Date.now(),r=n.playerTimeMs,o=n.stallDetectionMs||ui;if(r>this.progressTracker.lastDownloadedDuration)return this.progressTracker.lastProgressTime=t,this.progressTracker.lastDownloadedDuration=r,this.progressTracker.stallCount=0,{shouldStop:!1,stalled:!1};if(t-this.progressTracker.lastProgressTime>o){if(this.progressTracker.stallCount++,this.logger.warn(f,`Stream stalled for ${o}ms (stall #${this.progressTracker.stallCount})`),this.progressTracker.stallCount>=Bt)throw new Error(`Stream stalled ${Bt} times, aborting`);if(this.progressTracker.lastProgressTime=t,Math.abs(this.durationMs-r)<5e3){this.logger.warn(f,\"Stream is close to completion, but stalled. Checking if we have the last segment.\");let d=parseInt(this.mainFormat?.formatInitializationMetadata.endSegmentNumber||\"0\")||-1,c=this.mainFormat?.downloadedSegments.get(d);if(c&&c.segmentNumber===d)return this.logger.warn(f,\"Last segment is already downloaded. Stopping further processing.\"),{shouldStop:!0,stalled:!0}}return{shouldStop:!1,stalled:!0}}return{shouldStop:!1,stalled:!1}}selectFormats(n){let t=xe(this.formatIds,n.videoFormat,{quality:n.videoQuality,preferWebM:n.preferWebM,preferH264:n.preferH264,preferMP4:n.preferMP4,isAudio:!1}),r=xe(this.formatIds,n.audioFormat,{quality:n.audioQuality,language:n.audioLanguage,preferOpus:n.preferOpus,preferMP4:n.preferMP4,preferWebM:n.preferWebM,isAudio:!0});if(this.durationMs<0)throw new Error(\"Invalid duration\");if(!t||!r)throw new Error(\"No suitable formats found for download\");return{videoFormat:t,audioFormat:r}}async fetchAndProcessSegments(n,t,r){let o=this.initializedFormatsMap.get(_(r)||\"\"),i=this.initializedFormatsMap.get(_(t)||\"\");this.cachedBufferedRanges?.length||(this.cachedBufferedRanges=this.buildBufferedRanges(o,i));let d=this.buildRequestBody(n,t,r);this.mediaHeadersProcessed=!1;let c=await this.makeStreamingRequest(d),u=await this.processStreamingResponse(c);if(u.length){if((this.streamProtectionStatus?.status||0)>=2&&!u.includes(E.MEDIA))throw new Error(\"No media parts or protocol updates received from server.\")}else throw new Error(\"No valid parts received from server.\");(u.includes(E.MEDIA_HEADER)&&o?.lastMediaHeaders?.length&&i?.lastMediaHeaders?.length||n.enabledTrackTypesBitfield!==0&&this.mainFormat?.lastMediaHeaders?.length)&&(this.mediaHeadersProcessed=!0)}buildBufferedRanges(n,t){let r=[],o=[n,t];for(let i of o){if(!i?.lastMediaHeaders.length||le(i.formatInitializationMetadata)===this.formatToDiscard)continue;let d=i.lastMediaHeaders,c=d.reduce((u,I)=>u+parseInt(I.durationMs||\"0\"),0);r.push({durationMs:c.toString(),formatId:i.formatInitializationMetadata.formatId,startTimeMs:String(d[0].startMs||\"0\"),startSegmentIndex:d[0].sequenceNumber||1,endSegmentIndex:d[d.length-1].sequenceNumber||1,timeRange:{durationTicks:c.toString(),startTicks:d[0].startMs,timescale:d[0].timeRange?.timescale}}),i.lastMediaHeaders=[]}return r}buildRequestBody(n,t,r){if(!this.videoPlaybackUstreamerConfig)throw new Error(\"Video playback ustreamer config must be set before starting.\");if(!this.clientInfo)throw new Error(\"Client info must be set before starting.\");let o=this.cachedBufferedRanges||[],{sabrContexts:i,unsentSabrContexts:d}=this.prepareSabrContexts(),{selectedFormatIds:c,updatedBufferedRanges:u}=this.prepareFormatSelections([r,t],o);return Z.encode({clientAbrState:n,preferredAudioFormatIds:[t],preferredVideoFormatIds:[r],preferredSubtitleFormatIds:[],selectedFormatIds:c,videoPlaybackUstreamerConfig:se(this.videoPlaybackUstreamerConfig),streamerContext:{sabrContexts:i,unsentSabrContexts:d,poToken:this.poToken?se(this.poToken):void 0,playbackCookie:this.nextRequestPolicy?.playbackCookie?M.encode(this.nextRequestPolicy.playbackCookie).finish():void 0,clientInfo:this.clientInfo},bufferedRanges:u,field1000:[]}).finish()}prepareSabrContexts(){let n=[],t=[];for(let r of this.sabrContexts.values())this.activeSabrContextTypes.has(r.type)?n.push(r):t.push(r.type);return{sabrContexts:n,unsentSabrContexts:t}}prepareFormatSelections(n,t){let r=[],o=[...t],i=this.initializedFormatsMap.size>0;for(let d of n){let c=_(d),u=this.formatToDiscard&&c===this.formatToDiscard;u&&o.push({formatId:d,durationMs:L,startTimeMs:String(0),startSegmentIndex:parseInt(L),endSegmentIndex:parseInt(L),timeRange:{durationTicks:L,startTicks:\"0\",timescale:1e3}}),(i||u)&&r.push(d)}return{selectedFormatIds:r,updatedBufferedRanges:o}}async makeStreamingRequest(n){if(!this.serverAbrStreamingUrl)throw new Error(\"Server ABR streaming URL not configured.\");let t=new URL(this.serverAbrStreamingUrl);t.searchParams.set(\"rn\",this.requestNumber.toString()),this.abortController=new AbortController;let r=setTimeout(()=>this.abortController?.abort(),6e4);try{return await this.fetchFunction(t,{method:\"POST\",headers:{\"content-type\":\"application/x-protobuf\",\"accept-encoding\":\"identity\",accept:\"application/vnd.yt-ump\"},body:n,signal:this.abortController.signal})}finally{clearTimeout(r),this.requestNumber+=1}}async processStreamingResponse(n){if(!n.ok)throw new Error(`Server returned ${n.status} ${n.statusText}`);if(n.headers.get(\"content-type\")!==\"application/vnd.yt-ump\")throw new Error(`Unexpected content type from server: ${n.headers.get(\"content-type\")}`);let t=n.body.getReader(),r=!1,o,i=[];for(;;){if(this.abortController?.signal?.aborted&&!this._aborted)throw new Error(\"Stream was aborted.\");let{done:d,value:c}=await t.read();if(d){if(!r)throw new Error(\"Received empty response from server.\");break}r=!0;let u;o?(u=o.data,u.append(c)):u=new V([c]),o=new W(u).read(k=>{i.push(k.type);let D=this.umpPartHandlers.get(k.type);D&&D(k)})}return i}async executeWithRetry(n,t){let r=this.nextRequestPolicy?.backoffTimeMs||0;r>0&&(this.logger.debug(f,`Respecting server backoff policy: waiting ${r}ms before request`),await ce(r));for(let o=1;o<=t+1;o++)try{return await n(),this.mediaHeadersProcessed&&(this.cachedBufferedRanges=void 0),!0}catch(i){let d=i;if(this._aborted)return this.logger.debug(f,\"Download process aborted, skipping retry.\"),!1;if(o>t){this.logger.error(f,`Maximum retries (${t}) exceeded while fetching segment: ${d.message}`),this.errorHandler(d,!0);break}let c=Math.min(ci*Math.pow(2,o-1),si);this.logger.warn(f,`Segment fetch attempt ${o}/${t+1} failed - retrying in ${c}ms`,d),await ce(c)}finally{this.partialSegmentQueue.clear()}return!1}decodePart(n,t){if(n.data.chunks.length)try{return t.decode(ye(n.data.chunks))}catch{return}}handleFormatInitializationMetadata(n){let t=this.decodePart(n,z);if(!t)return;let r=le(t),o={formatInitializationMetadata:t,downloadedSegments:new Map,lastMediaHeaders:[]};this.initializedFormatsMap.set(r,o),this.logger.debug(f,`Initialized format: ${r}`),this.emit(\"formatInitialization\",o)}handleNextRequestPolicy(n){this.nextRequestPolicy=this.decodePart(n,J)}handleSabrError(n){let t=this.decodePart(n,ee);if(t)throw new Error(`SABR Error: ${t.type} - ${t.code}`)}handleSabrRedirect(n){let t=this.decodePart(n,te);t&&t.url&&(this.serverAbrStreamingUrl=t.url,this.logger.debug(f,`Redirecting to ${this.serverAbrStreamingUrl}`))}handleSabrContextUpdate(n){let t=this.decodePart(n,re);if(t&&t.type!==void 0&&t.value?.length){if(t.writePolicy===oe.KEEP_EXISTING&&this.sabrContexts.has(t.type)){this.logger.debug(f,`Skipping SABR context update for type ${t.type}`);return}this.sabrContexts.set(t.type,t),t.sendByDefault&&this.activeSabrContextTypes.add(t.type),this.logger.debug(f,`Received SABR context update (type: ${t.type}, sendByDefault: ${t.sendByDefault})`)}}handleSabrContextSendingPolicy(n){let t=this.decodePart(n,ae);if(t){for(let r of t.startPolicy)this.activeSabrContextTypes.has(r)||(this.activeSabrContextTypes.add(r),this.logger.debug(f,`Activated SABR context for type ${r}`));for(let r of t.stopPolicy)this.activeSabrContextTypes.has(r)&&(this.activeSabrContextTypes.delete(r),this.logger.debug(f,`Deactivated SABR context for type ${r}`));for(let r of t.discardPolicy)this.sabrContexts.has(r)&&(this.sabrContexts.delete(r),this.logger.debug(f,`Discarded SABR context for type ${r}`))}}handleStreamProtectionStatus(n){if(this.streamProtectionStatus=this.decodePart(n,de),!!this.streamProtectionStatus){if(this.emit(\"streamProtectionStatusUpdate\",this.streamProtectionStatus),this.streamProtectionStatus.status===3)throw new Error(\"Cannot proceed with stream: attestation required\");this.streamProtectionStatus.status===2&&this.logger.warn(f,\"Attestation pending.\")}}handleReloadPlayerResponse(n){let t=this.decodePart(n,ie);if(!t)return;let r=\"Player response reload requested by server\";throw this.logger.debug(f,`${r} (token: ${t.reloadPlaybackParams?.token}`),this.emit(\"reloadPlayerResponse\",t),new Error(r)}handleMediaHeader(n){let t=this.decodePart(n,$);if(!t)return;let r=t.headerId||0,o=me(t),i=t.isInitSeg?0:t.sequenceNumber||0,d=t.durationMs||Math.ceil(parseInt(t.timeRange?.durationTicks||\"0\")/(t.timeRange?.timescale||0)*1e3).toString(),c=this.initializedFormatsMap.get(o);if(!c){this.logger.warn(f,`No initialized format found for key: ${o} (segment ${i})`);return}let u=Oe(c);if(c.downloadedSegments.has(i)){this.logger.debug(f,`Segment ${o} (segment: ${i}) already downloaded. Ignoring.`);return}this.partialSegmentQueue.set(r,{formatIdKey:o,segmentNumber:i,durationMs:d,mediaHeader:t,bufferedChunks:[]}),this.logger.debug(f,`Enqueued ${u} segment ${i} (Header ID: ${r}, key: ${o}, duration: ${d}ms)`)}handleMedia(n){let t=n.data.getUint8(0),r=this.partialSegmentQueue.get(t);if(!r){this.logger.debug(f,`Received Media part for an unknown Header ID: ${t}`);return}if(!this.initializedFormatsMap.get(r.formatIdKey)){this.logger.warn(f,`No initialized format found for key ${r.formatIdKey} (segment ${r.segmentNumber})`);return}let i=n.data.split(1).remainingBuffer;for(let d of i.chunks)r.bufferedChunks.push(d)}handleMediaEnd(n){let t=n.data.getUint8(0),r=this.partialSegmentQueue.get(t);if(!r){this.logger.debug(f,`Received MediaEnd for an unknown Header ID: ${t}`);return}let o=r.bufferedChunks.reduce((d,c)=>d+c.length,0);if(o!==parseInt(r.mediaHeader.contentLength||\"0\")){this.logger.warn(f,`Content length mismatch for segment ${r.segmentNumber} (Header ID: ${t}, key: ${r.formatIdKey}, expected: ${r.mediaHeader.contentLength}, received: ${o})`),this.partialSegmentQueue.delete(t);return}let i=this.initializedFormatsMap.get(r.formatIdKey);if(i){let d=Oe(i);if(r.bufferedChunks.length)for(let c of r.bufferedChunks)d===\"audio\"?this.audioController?.enqueue(c):this.videoController?.enqueue(c);this.logger.debug(f,`Received MediaEnd for ${d} segment ${r.segmentNumber} (Header ID: ${t}, key: ${r.formatIdKey})`),r.bufferedChunks.length=0,r.bufferedChunks=[],i.lastMediaHeaders.push(r.mediaHeader),i.downloadedSegments.set(r.segmentNumber,r),this.partialSegmentQueue.delete(t)}}validateAndCorrectDuration(n){let t=parseInt(n.durationUnits||\"0\"),r=parseInt(n.durationTimescale||\"0\");if(r===0){this.logger.warn(f,\"Invalid timescale (0) in format initialization metadata\");return}let o=Math.trunc(t/(r/1e3));this.durationMs!==o&&(this.durationMs=o,this.logger.debug(f,`Corrected stream duration to ${this.durationMs}ms based on format initialization metadata`))}validateDownloadedSegments(){for(let[n,t]of this.initializedFormatsMap.entries()){if(n===this.formatToDiscard){this.logger.debug(f,`Skipping validation for discarded format: ${n}`);continue}let r=pe(t),o=parseInt(t.formatInitializationMetadata.durationUnits||\"0\"),i=parseInt(t.formatInitializationMetadata.durationTimescale||\"0\"),d=i?o/(i/1e3):0,c=Math.abs(r-d);if(d>0&&c>d*.01){let p=Math.round(r/d*100);this.logger.warn(f,`Incomplete stream for format ${n}: downloaded ${r}ms (${p}%), expected ${d}ms`)}let u=Array.from(t.downloadedSegments.entries());if(u.length===0)continue;u.sort(([p],[Dt])=>p-Dt);let I=parseInt(t.formatInitializationMetadata.endSegmentNumber||\"0\"),k=[];for(let p=0;p<=I;p++)t.downloadedSegments.has(p)||k.push(p);let D=new Set(u.map(([p])=>p)).size,Lt=D!==u.length;if(k.length>0){let p=`Format ${n}: Missing segments: [${k.join(\", \")}]. Expected range: 0-${I}. `;this.logger.warn(f,p),this.errorHandler(new Error(p),!0)}else this.logger.debug(f,`Format ${n}: All ${I} segments present (100% coverage)`);if(Lt){let p=`Format ${n}: Found duplicate segment numbers (${u.length} segments but ${D} unique numbers)`;this.logger.warn(f,p),this.errorHandler(new Error(p),!0)}}}resetState(){this.initializedFormatsMap.clear(),this.partialSegmentQueue.clear(),this.activeSabrContextTypes.clear(),this.sabrContexts.clear(),this.nextRequestPolicy=void 0,this.mainFormat=void 0,this.requestNumber=0,this.cachedBufferedRanges=void 0,this.mediaHeadersProcessed=!1,this.streamProtectionStatus=void 0,this.formatToDiscard=void 0,this.abortController=void 0,this.progressTracker={lastProgressTime:Date.now(),lastDownloadedDuration:0,stallCount:0}}errorHandler(n,t=!0){this.resetState(),this.logger.error(f,`Stream error: ${n.message}`),t&&(this._errored=!0,this.videoController?.error(n),this.audioController?.error(n))}};var De={};B(De,{AudioQuality:()=>ze,AuthorizedFormat:()=>q,BufferedRange:()=>S,ClientAbrState:()=>C,ClientInfo:()=>X,CompressionType:()=>qe,CryptoParams:()=>w,FormatId:()=>l,FormatInitializationMetadata:()=>z,FormatSelectionConfig:()=>Ot,HttpHeader:()=>N,IdentifierToken:()=>Je,InnertubeRequest:()=>F,KeyValuePair:()=>et,LiveMetadata:()=>mt,MediaCapabilities:()=>U,MediaHeader:()=>$,NetworkMeteredState:()=>Qe,NextRequestPolicy:()=>J,OnesieHeader:()=>It,OnesieHeaderType:()=>kt,OnesieInnertubeRequest:()=>Tt,OnesieInnertubeResponse:()=>At,OnesieProxyStatus:()=>yt,OnesieRequest:()=>_t,OnesieRequestTarget:()=>Ze,PlaybackAudioRouteOutputType:()=>je,PlaybackAuthorization:()=>g,PlaybackCookie:()=>M,PlaybackStartPolicy:()=>rt,Range:()=>m,ReloadPlaybackContext:()=>ie,ReloadPlaybackParams:()=>O,RequestCancellationPolicy:()=>pt,RequestIdentifier:()=>Et,SabrContextSendingPolicy:()=>ae,SabrContextUpdate:()=>re,SabrContextValue:()=>Pt,SabrContextWritePolicy:()=>oe,SabrError:()=>ee,SabrRedirect:()=>te,SabrSeek:()=>bt,SeekSource:()=>Xe,SnackbarMessage:()=>Mt,StreamProtectionStatus:()=>de,StreamerContext:()=>P,UMPPartId:()=>E,UstreamerFlags:()=>ne,VideoPlaybackAbrRequest:()=>Z,VideoQualitySetting:()=>$e});var ge={};B(ge,{CacheManager:()=>Ne,EnabledTrackTypes:()=>Ae,EventEmitterLike:()=>K,FormatKeyUtils:()=>he,LogLevel:()=>h,Logger:()=>x,MAX_INT32_VALUE:()=>L,RequestMetadataManager:()=>Pe,SabrAdapterError:()=>Ce,base64ToU8:()=>se,buildSabrFormat:()=>ni,concatenateChunks:()=>ye,isGoogleVideoURL:()=>Jn,parseRangeHeader:()=>ei,u8ToBase64:()=>ti,wait:()=>ce});var we={};B(we,{CompositeBuffer:()=>V,UmpReader:()=>W,UmpWriter:()=>Ue});var Ue=class{constructor(n){this.compositeBuffer=n}write(n,t){let r=t.length;this.writeVarInt(n),this.writeVarInt(r),this.compositeBuffer.append(t)}writeVarInt(n){if(n<0)throw new Error(\"VarInt value cannot be negative.\");if(n<128)this.compositeBuffer.append(new Uint8Array([n]));else if(n<16384)this.compositeBuffer.append(new Uint8Array([n&63|128,n>>6]));else if(n<2097152)this.compositeBuffer.append(new Uint8Array([n&31|192,n>>5&255,n>>13]));else if(n<268435456)this.compositeBuffer.append(new Uint8Array([n&15|224,n>>4&255,n>>12&255,n>>20]));else{let t=new Uint8Array(5),r=new DataView(t.buffer);t[0]=240,r.setUint32(1,n,!0),this.compositeBuffer.append(t)}}};return vt(fi);})();\n";

  function ensureDefaultTrustedTypesPolicy() {
    if (!window.trustedTypes) return;
    if (trustedTypes.defaultPolicy) return;
    try {
      trustedTypes.createPolicy('default', {
        createScript: (code) => code,
        createScriptURL: (url) => url,
        createHTML: (html) => html,
      });
    } catch (e) {
      console.error('[ytdl] Не удалось создать default Trusted Types policy:', e);
    }
  }

  function evalAsScript(src, returnExpr) {
    ensureDefaultTrustedTypesPolicy();
    const fn = new Function(src + '\n' + returnExpr);
    return fn();
  }

  let GV = null;
  try {
    GV = evalAsScript(GOOGLEVIDEO_BUNDLE_SRC, 'return GoogleVideoBundle;');
  } catch (e) {
    console.error('[ytdl] Не удалось выполнить встроенный бандл googlevideo:', e);
  }

  const MEDIABUNNY_URL = 'https://cdn.jsdelivr.net/npm/mediabunny@1/dist/bundles/mediabunny.cjs';

  function loadMediabunny() {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: MEDIABUNNY_URL,
        onload: (res) => {
          if (res.status < 200 || res.status >= 300) {
            reject(new Error(`Mediabunny: HTTP ${res.status}`));
            return;
          }
          try {
            resolve(evalAsScript(res.responseText, 'return Mediabunny;'));
          } catch (e) {
            reject(e);
          }
        },
        onerror: () => reject(new Error('Сетевая ошибка')),
      });
    });
  }

  function whenDomReady(cb) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', cb, { once: true });
    } else {
      cb();
    }
  }

  whenDomReady(() => {
    if (!GV) { console.error('[ytdl] googlevideo(SABR) не загружен, скрипт не может продолжить'); return; }
    loadMediabunny()
      .then((M) => {
        console.log('[ytdl] Mediabunny + googlevideo(SABR) готовы, скрипт активен');
        initYtdl(M, GV);
      })
      .catch((e) => console.error('[ytdl] Mediabunny не загрузился:', e));
  });

  function initYtdl(M, GV) {
    const {
      Input, Output, Conversion, ALL_FORMATS,
      BlobSource, Mp4OutputFormat, WebMOutputFormat, OggOutputFormat, BufferTarget,
    } = M;

    const SabrStream = GV.SabrStreamMod.SabrStream;
    const VideoPlaybackAbrRequest = GV.Protos.VideoPlaybackAbrRequest;

    let tvHtml5Formats = [];

    function codecOf(mimeType) {
      const m = /codecs="([^"]+)"/.exec(mimeType || '');
      return m ? m[1].split('.')[0].toLowerCase() : '';
    }

    const K_LABELS = { '1440': '2K', '2160': '4K', '4320': '8K' };
    function formatQualityLabel(v) {
      const label = v.qualityLabel || (v.height + 'p');
      return label.replace(/^(1440|2160|4320)p/, (full, h) => K_LABELS[h]);
    }

    const CODEC_PREFERENCE = { av01: 3, vp9: 2, avc1: 1 };
    function pickBestPerResolution(videoFormats) {
      const byHeight = new Map();
      for (const f of videoFormats) {
        const codec = codecOf(f.mimeType);
        const rank = CODEC_PREFERENCE[codec] || 0;
        const existing = byHeight.get(f.height);
        if (!existing || rank > existing.__rank || (rank === existing.__rank && f.bitrate > existing.bitrate)) {
          byHeight.set(f.height, Object.assign({ __rank: rank }, f));
        }
      }
      return [...byHeight.values()];
    }

    function u8ToBase64(u8) {
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < u8.length; i += chunk) {
        binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
      }
      return btoa(binary);
    }

    function createDownloadController() {
      let paused = false;
      let cancelled = false;
      let resumeWaiters = [];
      const abortFns = new Set();

      function makeCancelError() {
        return Object.assign(new Error('Отменено пользователем'), { cancelled: true });
      }

      return {
        get paused() { return paused; },
        get cancelled() { return cancelled; },
        pause() {
          paused = true;
          abortFns.forEach((fn) => { try { fn(); } catch (e) {} });
        },
        resume() {
          paused = false;
          const waiters = resumeWaiters;
          resumeWaiters = [];
          waiters.forEach((r) => r());
        },
        cancel() {
          if (cancelled) return;
          cancelled = true;
          abortFns.forEach((fn) => { try { fn(); } catch (e) {} });
          this.resume();
        },
        async waitIfPaused() {
          while (paused && !cancelled) {
            await new Promise((r) => resumeWaiters.push(r));
          }
        },
        throwIfCancelled() {
          if (cancelled) throw makeCancelError();
        },
        registerAbort(fn) { abortFns.add(fn); },
        unregisterAbort(fn) { abortFns.delete(fn); },
        makeCancelError,
      };
    }

    function gmRangeGet(url, start, end, onChunkProgress, controller) {
      return new Promise((resolve, reject) => {
        if (controller && controller.cancelled) { reject(controller.makeCancelError()); return; }

        let req;
        const abortFn = () => { try { if (req && req.abort) req.abort(); } catch (e) {} };
        if (controller) controller.registerAbort(abortFn);
        const cleanup = () => { if (controller) controller.unregisterAbort(abortFn); };

        req = GM_xmlhttpRequest({
          method: 'GET',
          url,
          responseType: 'arraybuffer',
          headers: { 'Range': `bytes=${start}-${end}` },
          onprogress: (res) => {
            if (onChunkProgress && typeof res.loaded === 'number') onChunkProgress(res.loaded);
          },
          onload: (res) => {
            cleanup();
            if (res.status === 200 || res.status === 206) {
              resolve(res);
              return;
            }
            let bodyPreview = '';
            try {
              const bytes = new Uint8Array(res.response || new ArrayBuffer(0));
              bodyPreview = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 500));
            } catch (e) {}
            console.error(`[ytdl][diag] HTTP ${res.status} на диапазон ${start}-${end}, тело ответа:`, bodyPreview || '(пусто)');
            reject(new Error(`HTTP ${res.status} при скачивании чанка${bodyPreview ? ' — ' + bodyPreview.slice(0, 200) : ''}`));
          },
          onerror: (err) => {
            cleanup();
            if (controller && controller.cancelled) { reject(controller.makeCancelError()); return; }
            console.error('[ytdl][diag] сетевая ошибка GM_xmlhttpRequest:', err);
            reject(new Error('Сетевая ошибка при скачивании чанка'));
          },
          onabort: () => {
            cleanup();
            if (controller && controller.cancelled) { reject(controller.makeCancelError()); return; }
            reject(Object.assign(new Error('Пауза'), { pausedAbort: true }));
          },
        });
      });
    }

    function parseContentRangeTotal(headersText) {
      const m = /content-range:\s*bytes\s+\d+-\d+\/(\d+)/i.exec(headersText || '');
      return m ? parseInt(m[1], 10) : null;
    }

    function concatBuffers(buffers, totalLen) {
      const out = new Uint8Array(totalLen);
      let offset = 0;
      for (const b of buffers) {
        out.set(new Uint8Array(b), offset);
        offset += b.byteLength;
      }
      return out.buffer;
    }

    async function fetchChunkWithPauseRetry(url, start, end, onChunkProgress, controller) {
      while (true) {
        if (controller) { await controller.waitIfPaused(); controller.throwIfCancelled(); }
        try {
          return await gmRangeGet(url, start, end, onChunkProgress, controller);
        } catch (e) {
          if (e && e.pausedAbort) continue;
          throw e;
        }
      }
    }

    async function downloadWithFetchStream(url, onProgress, controller) {
      let received = 0;
      let total = 0;
      const chunks = [];
      let rangeSupported = null;

      for (;;) {
        if (controller) { await controller.waitIfPaused(); controller.throwIfCancelled(); }

        const abortController = new AbortController();
        const abortFn = () => { try { abortController.abort(); } catch (e) {} };
        if (controller) controller.registerAbort(abortFn);

        try {
          const headers = (received > 0 && rangeSupported) ? { Range: `bytes=${received}-` } : {};
          const resp = await origFetch.call(uw, url, { headers, signal: abortController.signal });

          if (received > 0 && rangeSupported && resp.status !== 206) { received = 0; chunks.length = 0; }
          if (!resp.ok && resp.status !== 206) throw new Error(`HTTP ${resp.status} при скачивании`);
          if (!resp.body || !resp.body.getReader) throw new Error('ReadableStream недоступен для этого URL');

          if (rangeSupported === null) {
            rangeSupported = resp.status === 206 || resp.headers.get('Accept-Ranges') === 'bytes';
          }
          if (!total) {
            const cr = resp.headers.get('Content-Range');
            const cl = resp.headers.get('Content-Length');
            if (cr) { const m = /\/(\d+)$/.exec(cr); if (m) total = parseInt(m[1], 10); }
            else if (cl) total = received + parseInt(cl, 10);
          }

          const reader = resp.body.getReader();

          try {
            while (true) {
              if (controller) controller.throwIfCancelled();
              const { done, value } = await reader.read();
              if (done) {
                const size = total || received;
                const out = new Uint8Array(size);
                let offset = 0;
                for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
                return out.buffer;
              }
              chunks.push(value);
              received += value.byteLength;
              if (onProgress) onProgress(received, total);
            }
          } catch (e) {
            if (controller && controller.cancelled) throw controller.makeCancelError();
            if (!(controller && controller.paused)) throw e;
          }
        } finally {
          if (controller) controller.unregisterAbort(abortFn);
        }

        if (!rangeSupported) { received = 0; chunks.length = 0; }
      }
    }

    async function downloadDirectSmart(url, onProgress, knownTotal, controller) {
      try {
        return await downloadWithFetchStream(url, onProgress, controller);
      } catch (e) {
        if (e && e.cancelled) throw e;
        console.warn('[ytdl] Потоковый fetch недоступен (' + e.message + '), использую Range-чанки как запасной вариант');
        return await downloadDirectRanged(url, onProgress, knownTotal, controller);
      }
    }

    async function downloadDirectRanged(url, onProgress, knownTotal, controller) {
      const CHUNK = 10 * 1024 * 1024;
      const parts = [];
      let received = 0;
      let total = knownTotal || 0;

      const first = await fetchChunkWithPauseRetry(url, 0, CHUNK - 1, (loaded) => {
        if (onProgress) onProgress(loaded, total);
      }, controller);
      total = parseContentRangeTotal(first.responseHeaders) || total || first.response.byteLength;
      parts.push(first.response);
      received = first.response.byteLength;
      if (onProgress) onProgress(received, total);

      while (received < total) {
        const start = received;
        const end = Math.min(start + CHUNK - 1, total - 1);
        const baseReceived = received;
        const res = await fetchChunkWithPauseRetry(url, start, end, (loaded) => {
          if (onProgress) onProgress(baseReceived + loaded, total);
        }, controller);
        parts.push(res.response);
        received += res.response.byteLength;
        if (onProgress) onProgress(received, total);
      }
      return concatBuffers(parts, received);
    }

    function getPlayerResponse() {
      try {
        const el = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
        if (el && typeof el.getPlayerResponse === 'function') {
          const pr = el.getPlayerResponse();
          if (pr && pr.streamingData) return pr;
        }
      } catch (e) {}
      try {
        if (uw.ytInitialPlayerResponse && uw.ytInitialPlayerResponse.streamingData) return uw.ytInitialPlayerResponse;
      } catch (e) {}
      return null;
    }

    function getUstreamerConfigFromPlayerResponse(pr) {
      try {
        return pr.playerConfig.mediaCommonConfig.mediaUstreamerRequestConfig.videoPlaybackUstreamerConfig || null;
      } catch (e) { return null; }
    }

    function buildSabrFormats(pr) {
      const all = [...(pr.streamingData.adaptiveFormats || []), ...(pr.streamingData.formats || [])];
      return all.map((f) => ({
        itag: f.itag,
        lastModified: f.lastModified || '0',
        xtags: f.xtags,
        width: f.width,
        height: f.height,
        contentLength: f.contentLength ? parseInt(f.contentLength, 10) : undefined,
        mimeType: f.mimeType,
        quality: f.quality,
        qualityLabel: f.qualityLabel,
        averageBitrate: f.averageBitrate,
        bitrate: f.bitrate || 0,
        audioQuality: f.audioQuality,
        approxDurationMs: f.approxDurationMs ? parseInt(f.approxDurationMs, 10) : 0,
      }));
    }

    let cachedPlayerJsUrl = null;
    let cachedDecipherFn = null;
    let cachedNTransformFn = null;

    function findPlayerJsUrl() {
      try {
        if (uw.ytcfg && typeof uw.ytcfg.get === 'function') {
          const url = uw.ytcfg.get('PLAYER_JS_URL');
          if (url) return url.startsWith('http') ? url : `https://www.youtube.com${url}`;
        }
      } catch (e) {}
      try {
        const html = document.documentElement.innerHTML;
        const m1 = /"PLAYER_JS_URL":"([^"]+)"/.exec(html);
        if (m1) {
          const path = m1[1].replace(/\\\//g, '/');
          return path.startsWith('http') ? path : `https://www.youtube.com${path}`;
        }
        const m2 = /\/s\/player\/[a-zA-Z0-9_]+\/(?:tv-)?(?:[a-zA-Z0-9_-]+\/)*base\.js/.exec(html);
        if (m2) return `https://www.youtube.com${m2[0]}`;
      } catch (e) {}
      return null;
    }

    async function fetchPlayerJsSource() {
      const url = findPlayerJsUrl();
      if (!url) throw new Error('не найден PLAYER_JS_URL на странице');
      const res = await origFetch(url);
      if (!res.ok) throw new Error(`не удалось скачать player.js: HTTP ${res.status}`);
      return { url, source: await res.text() };
    }

    function extractDecipherFunction(playerSrc) {
      const mainFnMatch = playerSrc.match(
        /function\(a\)\{a=a\.split\(""\);([\s\S]*?)return a\.join\(""\)\}/
      );
      if (!mainFnMatch) throw new Error('не найден главную decipher-функцию в player.js (обфускация изменилась)');
      const fullFnSrc = mainFnMatch[0];

      const helperNameMatch = fullFnSrc.match(/;([a-zA-Z0-9$]{1,4})\.[a-zA-Z0-9$]{1,4}\(a,\d+\)/);
      if (!helperNameMatch) throw new Error('не найден имя объекта-помощника decipher-функции');
      const helperName = helperNameMatch[1];

      const escapedName = helperName.replace(/\$/g, '\\$');
      const helperDefRegex = new RegExp(
        `var\\s+${escapedName}\\s*=\\s*\\{([\\s\\S]*?)\\};`
      );
      const helperDefMatch = playerSrc.match(helperDefRegex);
      if (!helperDefMatch) throw new Error('не найден тело объекта-помощника "' + helperName + '"');

      const helperSrc = `var ${helperName} = {${helperDefMatch[1]}};`;
      const fnSrc = `${helperSrc}\nreturn (${fullFnSrc});`;

      let decipher;
      try {
        decipher = new Function(fnSrc)();
      } catch (e) {
        throw new Error('Ошибка выполнения извлечённой decipher-функции: ' + e.message);
      }
      if (typeof decipher !== 'function') throw new Error('decipher оказался не функцией');
      return decipher;
    }

    function extractNTransformFunction(playerSrc) {
      try {
        const m = playerSrc.match(
          /function\s*\(\s*a\s*\)\s*\{\s*var\s+b\s*=\s*a\.split\(""\)([\s\S]*?)return b\.join\(""\)\}/
        );
        if (!m) return null;
        const fn = new Function(`return (${m[0]});`)();
        return typeof fn === 'function' ? fn : null;
      } catch (e) {
        return null;
      }
    }

    async function getDecipherFunctions() {
      if (cachedDecipherFn) return { decipher: cachedDecipherFn, nTransform: cachedNTransformFn };
      const { url, source } = await fetchPlayerJsSource();
      cachedPlayerJsUrl = url;
      cachedDecipherFn = extractDecipherFunction(source);
      cachedNTransformFn = extractNTransformFunction(source);
      console.log('[ytdl][sig] decipher-функция извлечена из', url, '| n-transform найден:', !!cachedNTransformFn);
      return { decipher: cachedDecipherFn, nTransform: cachedNTransformFn };
    }

    async function resolveSignatureCipher(cipherStr) {
      const params = new URLSearchParams(cipherStr);
      const encodedUrl = params.get('url');
      const s = params.get('s');
      const sp = params.get('sp') || 'signature';
      if (!encodedUrl) throw new Error('в signatureCipher нет url');
      if (!s) return encodedUrl;

      const { decipher, nTransform } = await getDecipherFunctions();
      const decodedSig = decipher(s);

      const u = new URL(encodedUrl);
      u.searchParams.set(sp, decodedSig);

      if (nTransform) {
        const n = u.searchParams.get('n');
        if (n) {
          try {
            u.searchParams.set('n', nTransform(n));
          } catch (e) {
            console.warn('[ytdl][sig] Не удалось применить n-transform, остаётся как есть:', e.message);
          }
        }
      }

      return u.toString();
    }

    const INNERTUBE_CLIENTS = [
      {
        clientName: 'ANDROID_VR',
        clientNameId: 28,
        userAgent: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
        context: {
          clientName: 'ANDROID_VR',
          clientVersion: '1.65.10',
          deviceMake: 'Oculus',
          deviceModel: 'Quest 3',
          androidSdkVersion: 32,
          userAgent: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
          osName: 'Android',
          osVersion: '12L',
          hl: 'ru',
          gl: 'RU',
        },
      },
    ];

    function getCookie(name) {
      const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : null;
    }

    async function sha1Hex(text) {
      const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }

    async function getSapisidAuthHeader(origin) {
      const sapisid = getCookie('SAPISID') || getCookie('__Secure-3PAPISID');
      if (!sapisid) return null;
      const timestamp = Math.round(Date.now() / 1000);
      const hash = await sha1Hex(`${timestamp} ${sapisid} ${origin}`);
      return `SAPISIDHASH ${timestamp}_${hash}`;
    }

    function gmPost(url, headers, bodyObj, anonymous) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'POST',
          url,
          headers,
          data: JSON.stringify(bodyObj),
          anonymous: !!anonymous,
          onload: (res) => {
            if (res.status < 200 || res.status >= 300) {
              reject(Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, body: res.responseText }));
              return;
            }
            try { resolve(JSON.parse(res.responseText)); }
            catch (e) { reject(new Error('Не удалось распарсить JSON-ответ: ' + e.message)); }
          },
          onerror: () => reject(new Error('Сетевая ошибка запроса')),
        });
      });
    }

    const SEND_SESSION_AUTH_SIGNALS = false;

    async function fetchPlayerResponseAsClient(videoId, apiKey, clientDef) {
      let data;
      try {
        const origin = 'https://www.youtube.com';
        const authHeader = SEND_SESSION_AUTH_SIGNALS ? await getSapisidAuthHeader(origin) : null;

        let identityToken = null;
        let visitorData = null;
        try {
          if (SEND_SESSION_AUTH_SIGNALS) {
            identityToken = uw.ytcfg && uw.ytcfg.get('ID_TOKEN');
          }
          visitorData = uw.ytcfg && uw.ytcfg.get('VISITOR_DATA');
        } catch (e) {}

        const headers = {
          'Content-Type': 'application/json',
          'User-Agent': clientDef.userAgent,
          'X-YouTube-Client-Name': String(clientDef.clientNameId),
          'X-YouTube-Client-Version': clientDef.context.clientVersion,
          'Origin': origin,
        };
        if (authHeader) {
          headers['Authorization'] = authHeader;
          headers['X-Origin'] = origin;
        }
        if (identityToken) headers['X-Youtube-Identity-Token'] = identityToken;
        if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;

        const clientContext = { ...clientDef.context };
        if (visitorData) clientContext.visitorData = visitorData;

        const body = {
          context: { client: clientContext },
          videoId,
          contentCheckOk: true,
          racyCheckOk: true,
        };

        if (clientDef.clientName === 'WEB_EMBEDDED_PLAYER') {
          body.context.thirdParty = { embedUrl: 'https://www.youtube.com' };
        }

        data = await gmPost(
          `https://www.youtube.com/youtubei/v1/player?key=${apiKey}`,
          headers,
          body,
        );
      } catch (e) {
        console.warn(`[ytdl][tv] ${clientDef.clientName}: ${e.message}`);
        return null;
      }

      const status = data.playabilityStatus && data.playabilityStatus.status;
      if (!data.streamingData) {
        console.warn(`[ytdl][tv] ${clientDef.clientName}: нет streamingData, playabilityStatus:`, status, data.playabilityStatus && data.playabilityStatus.reason);
        return null;
      }
      console.log(`[ytdl][tv] ${clientDef.clientName}: streamingData получен (playabilityStatus: ${status})`);
      return data;
    }


    async function processClientFormats(data, clientName) {
      const streamingData = data.streamingData;
      const allFormats = [...(streamingData.formats || []), ...(streamingData.adaptiveFormats || [])];

      console.log(`[ytdl][tv] ${clientName}: сырые форматы:`, allFormats.map((f) => ({
        itag: f.itag,
        hasUrl: !!f.url,
        hasCipher: !!(f.signatureCipher || f.cipher),
      })));

      const existingItags = new Set(tvHtml5Formats.map((f) => f.itag));
      for (const fmt of allFormats) {
        if (!existingItags.has(fmt.itag)) tvHtml5Formats.push(fmt);
      }

      for (const fmt of allFormats) {
        if (fmt.itag == null) continue;
        if (capturedDirectByItag.has(String(fmt.itag))) continue;
        const cipherField = fmt.signatureCipher || fmt.cipher;
        if (fmt.url) {
          capturedDirectByItag.set(String(fmt.itag), {
            url: fmt.url,
            mime: fmt.mimeType || '',
            itag: String(fmt.itag)
          });
          console.log(`[ytdl][diag] ${clientName}: найден прямой url для itag=${fmt.itag}`);
        } else if (cipherField) {
          try {
            const directUrl = await resolveSignatureCipher(cipherField);
            capturedDirectByItag.set(String(fmt.itag), {
              url: directUrl,
              mime: fmt.mimeType || '',
              itag: String(fmt.itag)
            });
            console.log(`[ytdl][diag] ${clientName}: расшифровал signatureCipher для itag=${fmt.itag}`);
          } catch (e) {
            console.warn(`[ytdl][diag] ${clientName}: не удалось расшифровать signatureCipher для itag=${fmt.itag}:`, e.message);
          }
        } else {
          console.warn(`[ytdl][diag] ${clientName}: itag=${fmt.itag} без url/cipher (SABR-only формат) — ключи:`, Object.keys(fmt).join(', '));
        }
      }
    }

    async function fetchTvHtml5Formats(videoId) {
      tvHtml5Formats = [];
      try {
        const ytcfg = uw.ytcfg;
        if (!ytcfg) {
          console.warn('[ytdl][tv] ytcfg ещё не готов (скорее всего слишком рано, document-start) — отмена запроса');
          return;
        }
        const apiKey = ytcfg.get('INNERTUBE_API_KEY');
        if (!apiKey) {
          console.warn('[ytdl][tv] INNERTUBE_API_KEY не найден в ytcfg — отмена запроса');
          return;
        }

        let anySucceeded = false;
        for (const clientDef of INNERTUBE_CLIENTS) {
          const data = await fetchPlayerResponseAsClient(videoId, apiKey, clientDef);
          if (!data) continue;
          anySucceeded = true;
          await processClientFormats(data, clientDef.clientName);
        }
        if (!anySucceeded) {
          console.warn('[ytdl][tv] Ни один из клиентов не отдал streamingData:', INNERTUBE_CLIENTS.map((c) => c.clientName).join(', '));
        }
      } catch (e) {
        console.error('[ytdl] Ошибка запроса player API:', e);
      }
    }

    function getAllAvailableFormats() {
      const pr = getPlayerResponse();
      let formats = pr ? buildSabrFormats(pr) : [];

      if (tvHtml5Formats && tvHtml5Formats.length > 0) {
        const existingItags = new Set(formats.map(f => f.itag));
        const extraFormats = tvHtml5Formats
          .filter(f => !existingItags.has(f.itag))
          .map(f => ({
            itag: f.itag,
            lastModified: f.lastModified || '0',
            xtags: f.xtags,
            width: f.width,
            height: f.height,
            contentLength: f.contentLength ? parseInt(f.contentLength, 10) : undefined,
            mimeType: f.mimeType,
            quality: f.quality,
            qualityLabel: f.qualityLabel,
            averageBitrate: f.averageBitrate,
            bitrate: f.bitrate || 0,
            audioQuality: f.audioQuality,
            approxDurationMs: f.approxDurationMs ? parseInt(f.approxDurationMs, 10) : 0,
          }));
        formats = formats.concat(extraFormats);
      }
      return formats;
    }

    function buildSabrConfig() {
      if (!capturedSabr) {
        throw new Error('Ещё не перехвачен ни один SABR-запрос плеера — подождите пару секунд буферизации и попробуйте снова');
      }
      const decoded = VideoPlaybackAbrRequest.decode(capturedSabr.bodyBytes);
      const ctx = decoded.streamerContext;
      if (!ctx) throw new Error('В перехваченном запросе нет streamerContext — формат протокола, похоже, изменился');

      const pr = getPlayerResponse();
      if (!pr) throw new Error('Не найден player response на странице');

      const ustreamerConfig = decoded.videoPlaybackUstreamerConfig && decoded.videoPlaybackUstreamerConfig.length
        ? u8ToBase64(decoded.videoPlaybackUstreamerConfig)
        : getUstreamerConfigFromPlayerResponse(pr);
      if (!ustreamerConfig) throw new Error('Не найден videoPlaybackUstreamerConfig ни в запросе, ни в player response');

      return {
        serverAbrStreamingUrl: capturedSabr.url,
        videoPlaybackUstreamerConfig: ustreamerConfig,
        clientInfo: ctx.clientInfo,
        poToken: ctx.poToken && ctx.poToken.length ? u8ToBase64(ctx.poToken) : undefined,
        formats: getAllAvailableFormats(),
        durationMs: pr.videoDetails && pr.videoDetails.lengthSeconds
          ? parseInt(pr.videoDetails.lengthSeconds, 10) * 1000
          : undefined,
      };
    }

    const STALL_MS = 15000;

    async function readStreamToBuffer(readableStream, onProgress, approxTotal, label, controller) {
      const tag = label ? `[${label}] ` : '';
      const reader = readableStream.getReader();
      if (controller) controller.registerAbort(() => { try { reader.cancel(); } catch (e) {} });
      const chunks = [];
      let received = 0;
      while (true) {
        if (controller) {
          await controller.waitIfPaused();
          if (controller.cancelled) { try { await reader.cancel(); } catch (e) {} throw controller.makeCancelError(); }
        }

        let timer;
        const readPromise = reader.read();
        const timeoutPromise = new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`${tag}нет данных >${STALL_MS / 1000}с на ${received} байт — поток завис (см. консоль: fetch'и выше)`));
          }, STALL_MS);
        });

        let result;
        try {
          result = await Promise.race([readPromise, timeoutPromise]);
        } finally {
          clearTimeout(timer);
        }

        const { done, value } = result;
        if (done) {
          console.log(`[ytdl][diag] ${tag}стрим завершён нормально, всего байт:`, received);
          break;
        }
        chunks.push(value);
        received += value.byteLength;
        console.log(`[ytdl][diag] ${tag}чанк ${value.byteLength} байт, всего ${received}`, new Date().toISOString());
        if (onProgress) onProgress(received, approxTotal);
      }
      const out = new Uint8Array(received);
      let offset = 0;
      for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
      if (onProgress) onProgress(received, approxTotal || received);
      return out.buffer;
    }

    function makeThrottledFetch(minIntervalMs, label) {
      const tag = label ? `(${label}) ` : '';
      let lastCallAt = 0;
      let callCount = 0;
      return async function throttledFetch(...args) {
        const wait = lastCallAt + minIntervalMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        lastCallAt = Date.now();
        callCount++;
        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        console.log(`[ytdl][diag] fetch #${callCount} ${tag}→`, url.slice(0, 120));
        try {
          const res = await origFetch.apply(uw, args);
          const cl = res.headers.get('content-length');
          const ct = res.headers.get('content-type');
          console.log(`[ytdl][diag] fetch #${callCount} ${tag}статус ${res.status} | content-length: ${cl} | content-type: ${ct}`);
          return res;
        } catch (e) {
          console.error(`[ytdl][diag] fetch #${callCount} ${tag}упал:`, e.message);
          throw e;
        }
      };
    }

    async function muxVideoAudio(videoBuf, videoMime, audioBuf, audioMime, onProgress) {
      const outputFormat = new Mp4OutputFormat();
      const ext = 'mp4';

      const videoBlob = new Blob([videoBuf]);
      const audioBlob = new Blob([audioBuf]);

      const videoInput = new Input({ formats: ALL_FORMATS, source: new BlobSource(videoBlob) });
      const audioInput = new Input({ formats: ALL_FORMATS, source: new BlobSource(audioBlob) });

      const output = new Output({ format: outputFormat, target: new BufferTarget() });

      const videoConversion = await Conversion.init({
        input: videoInput, output, composable: true, audio: { discard: true },
      });
      const audioConversion = await Conversion.init({
        input: audioInput, output, composable: true, video: { discard: true },
      });

      if (!videoConversion.isValid || !audioConversion.isValid) {
        throw new Error('Конверсия невозможна (несовместимый кодек с контейнером)');
      }

      let vp = 0, ap = 0;
      videoConversion.onProgress = (p) => { vp = p; if (onProgress) onProgress((vp + ap) / 2); };
      audioConversion.onProgress = (p) => { ap = p; if (onProgress) onProgress((vp + ap) / 2); };

      await output.start();
      await Promise.all([videoConversion.execute(), audioConversion.execute()]);
      await output.finalize();

      const blob = new Blob([output.target.buffer], { type: outputFormat.mimeType });
      return { blob, ext };
    }

    async function muxAudioOnly(audioBuf, audioMime, onProgress) {
      const audioCodec = codecOf(audioMime);
      const useM4a = audioCodec === 'mp4a';
      const outputFormat = useM4a ? new Mp4OutputFormat() : new WebMOutputFormat();
      const ext = useM4a ? 'm4a' : 'webm';

      const audioBlob = new Blob([audioBuf]);
      const audioInput = new Input({ formats: ALL_FORMATS, source: new BlobSource(audioBlob) });
      const output = new Output({ format: outputFormat, target: new BufferTarget() });

      const conversion = await Conversion.init({ input: audioInput, output });
      if (!conversion.isValid) {
        throw new Error('Конверсия невозможна (несовместимый кодек с контейнером)');
      }
      conversion.onProgress = (p) => { if (onProgress) onProgress(p); };

      await conversion.execute();

      const blob = new Blob([output.target.buffer], { type: outputFormat.mimeType });
      return { blob, ext };
    }

    function triggerSave(blob, ext) {
      return new Promise((resolve, reject) => {
        try {
          const title = (document.title || 'youtube_video').replace(/\s*-\s*YouTube\s*$/, '');
          const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
          const blobUrl = URL.createObjectURL(blob);

          const a = document.createElement('a');
          a.href = blobUrl;
          a.download = `${safeTitle}.${ext}`;
          a.style.display = 'none';
          document.body.appendChild(a);
          a.click();
          a.remove();

          setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
          resolve();
        } catch (e) {
          reject(new Error('Не удалось сохранить файл: ' + e.message));
        }
      });
    }

    GM_addStyle(`
      #ytdl-menu { position: fixed; z-index: 99999; background: #282828; color: #eee;
        font: 13px/1.4 Roboto, Arial, sans-serif; border-radius: 12px; padding: 6px;
        width: 290px; max-height: 70vh; overflow-y: auto; box-shadow: 0 4px 20px rgba(0,0,0,.6); border: 1px solid #3f3f3f; }
      #ytdl-menu .ytdl-item { display: flex; justify-content: space-between; align-items: center;
        padding: 0px 10px; border-radius: 8px; cursor: pointer; }
      #ytdl-menu .ytdl-item:hover { background: #3f3f3f; }
      #ytdl-menu .ytdl-item[data-disabled="1"] { opacity: .5; pointer-events: none; }
      #ytdl-menu .ytdl-item .ytdl-badge { color: #aaa; font-size: 11px; }
      #ytdl-menu .ytdl-status { padding: 8px 10px; color: #aaa; font-size: 12px; white-space: pre-wrap; }
      #ytdl-menu .ytdl-header { padding: 3px 10px; color: #aaa; font-size: 11px; text-transform: uppercase;
        border-bottom: 1px solid #3f3f3f; margin-bottom: 2px; }
      #ytdl-menu .ytdl-header--audio { border-top: 1px solid #3f3f3f; }
      .ytdl-own-btn { display: inline-flex; align-items: center; gap: 6px; height: 36px;
        padding: 0 16px; margin-left: 8px; border-radius: 18px; border: none;
        background: #3f3f3f; color: #f1f1f1; font: 500 14px Roboto, Arial, sans-serif;
        cursor: pointer; }
      .ytdl-own-btn:hover { background: #4d4d4d; }

      #ytdl-modal-overlay { position: fixed; inset: 0; z-index: 100000;
        transition: background .35s ease; }
      #ytdl-modal-overlay:not(.ytdl-minimized) { background: rgba(0,0,0,.6); }
      #ytdl-modal-overlay.ytdl-minimized { background: transparent; pointer-events: none; }
      #ytdl-modal-box { position: fixed; background: #282828; color: #eee;
        border-radius: 12px; padding: 22px 26px; width: 320px; box-sizing: border-box;
        font: 13px/1.5 Roboto, Arial, sans-serif; box-shadow: 0 8px 30px rgba(0,0,0,.6);
        pointer-events: auto; overflow: hidden;
        transition: top .35s ease, left .35s ease, width .35s ease, border-radius .35s ease; }
      .ytdl-modal-title { font-size: 15px; font-weight: 600; margin-bottom: 12px; }
      .ytdl-modal-status { color: #ccc; white-space: pre-wrap; min-height: 20px; margin-bottom: 4px; }
      .ytdl-modal-close, .ytdl-modal-minimize { position: absolute; top: 8px; background: none;
        border: none; color: #999; font-size: 16px; line-height: 1; cursor: pointer; width: 22px; height: 22px; }
      .ytdl-modal-close { right: 8px; font-size: 20px; }
      .ytdl-modal-minimize { right: 32px; }
      .ytdl-modal-close:hover, .ytdl-modal-minimize:hover { color: #fff; }

      .ytdl-modal-expand { display: none; position: absolute; top: 50%; right: 10px;
        transform: translateY(-50%); background: none; border: none; color: #ccc;
        font-size: 16px; cursor: pointer; width: 22px; height: 22px; }
      .ytdl-modal-expand:hover { color: #fff; }

      .ytdl-stream-row { margin-bottom: 0px; }
      .ytdl-stream-row:last-child { margin-bottom: 0; }
      .ytdl-stream-label { color: #ccc; font-size: 12px; margin-bottom: 4px; }
      .ytdl-stream-speed { color: #999; font-size: 11px; text-align: center; margin-top: 4px; }
      .ytdl-progress-track { position: relative; height: 6px; border-radius: 3px;
        background: #3f3f3f; overflow: hidden; }
      .ytdl-progress-fill { position: absolute; inset: 0 auto 0 0; width: 0%;
        background: linear-gradient(90deg, #ff0033, #ff268e); border-radius: 3px; transition: width .15s linear; }

      .ytdl-modal-actions { display: flex; gap: 8px; margin-top: 7px; }
      .ytdl-modal-actions button { flex: 1; height: 32px; border: none; border-radius: 16px;
        background: #3f3f3f; color: #f1f1f1; font: 500 13px Roboto, Arial, sans-serif; cursor: pointer; }
      .ytdl-modal-actions button:hover { background: #4d4d4d; }
      .ytdl-modal-cancel:hover { background: #5a2a2a; }

      /* Свёрнутое состояние — только полоски прогресса, без текста */
      #ytdl-modal-box.ytdl-minimized .ytdl-modal-title,
      #ytdl-modal-box.ytdl-minimized .ytdl-modal-status,
      #ytdl-modal-box.ytdl-minimized .ytdl-stream-label,
      #ytdl-modal-box.ytdl-minimized .ytdl-stream-speed,
      #ytdl-modal-box.ytdl-minimized .ytdl-modal-actions,
      #ytdl-modal-box.ytdl-minimized .ytdl-modal-close,
      #ytdl-modal-box.ytdl-minimized .ytdl-modal-minimize {
        display: none;
      }
      #ytdl-modal-box.ytdl-minimized .ytdl-modal-expand { display: block; }
      #ytdl-modal-box.ytdl-minimized { cursor: grab; touch-action: none; }
      #ytdl-modal-box.ytdl-minimized:active { cursor: grabbing; }
      #ytdl-modal-box.ytdl-minimized .ytdl-modal-streams {
        display: flex; flex-direction: column; gap: 6px; padding-right: 22px;
      }
      #ytdl-modal-box.ytdl-minimized .ytdl-stream-row { margin-bottom: 0; }
    `);

    let modalEl = null;
    const speedTrackers = new Map();
    let activeSabrStream = null;
    let activeDownloadController = null;

    function closeModal() {
      if (activeDownloadController) {
        activeDownloadController.cancel();
        activeDownloadController = null;
      }
      if (activeSabrStream) {
        try { activeSabrStream.abort(); } catch (e) {}
        activeSabrStream = null;
      }
      if (modalEl) { modalEl.remove(); modalEl = null; }
      speedTrackers.clear();
    }

    function hideModal() {
      if (modalEl) modalEl.style.display = 'none';
    }

    function updatePauseButtonLabel() {
      if (!modalEl || !activeDownloadController) return;
      const btn = modalEl.querySelector('.ytdl-modal-pause');
      if (!btn) return;
      btn.textContent = activeDownloadController.paused ? '▶ Продолжить' : '⏸ Пауза';
    }

    const MODAL_MARGIN_X = 41;
    const MODAL_MARGIN_Y = 16;
    let lastMinimizedCorner = 'bottom-right';

    function placeModalAtCorner(box, corner, knownWidth) {
      const w = knownWidth != null ? knownWidth : box.offsetWidth;
      const h = box.offsetHeight;
      const left = corner.endsWith('right') ? window.innerWidth - w - MODAL_MARGIN_X : MODAL_MARGIN_X;
      const top = corner.startsWith('bottom') ? window.innerHeight - h - MODAL_MARGIN_Y : MODAL_MARGIN_Y;
      box.style.left = Math.round(left) + 'px';
      box.style.top = Math.round(top) + 'px';
    }

    function positionModalExpanded() {
      if (!modalEl) return;
      const box = modalEl.querySelector('#ytdl-modal-box');
      if (!box) return;
      const w = 320;
      box.style.width = w + 'px';
      box.style.padding = '22px 26px';
      box.style.borderRadius = '12px';
      box.style.left = Math.round((window.innerWidth - w) / 2) + 'px';
      box.style.top = Math.round((window.innerHeight - box.offsetHeight) / 2) + 'px';
    }

    function positionModalMinimized() {
      if (!modalEl) return;
      const box = modalEl.querySelector('#ytdl-modal-box');
      if (!box) return;
      box.style.width = '200px';
      box.style.padding = '14px 10px';
      box.style.borderRadius = '26px';
      placeModalAtCorner(box, lastMinimizedCorner, 200);
    }

    function snapModalToNearestCorner(box) {
      const w = box.offsetWidth;
      const h = box.offsetHeight;
      const rect = box.getBoundingClientRect();
      const centerX = rect.left + w / 2;
      const centerY = rect.top + h / 2;
      const vert = centerY < window.innerHeight / 2 ? 'top' : 'bottom';
      const horiz = centerX < window.innerWidth / 2 ? 'left' : 'right';
      lastMinimizedCorner = `${vert}-${horiz}`;
      placeModalAtCorner(box, lastMinimizedCorner);
    }

    function makeModalDraggable(box) {
      let dragging = false;
      let startX = 0, startY = 0, startLeft = 0, startTop = 0;

      box.addEventListener('pointerdown', (e) => {
        if (!box.classList.contains('ytdl-minimized')) return;
        if (e.target.closest('.ytdl-modal-expand')) return;
        dragging = true;
        box.style.transition = 'none';
        startX = e.clientX;
        startY = e.clientY;
        const rect = box.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
        e.preventDefault();
      });

      window.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const w = box.offsetWidth;
        const h = box.offsetHeight;
        let left = startLeft + (e.clientX - startX);
        let top = startTop + (e.clientY - startY);
        left = Math.min(Math.max(left, 0), window.innerWidth - w);
        top = Math.min(Math.max(top, 0), window.innerHeight - h);
        box.style.left = Math.round(left) + 'px';
        box.style.top = Math.round(top) + 'px';
      });

      window.addEventListener('pointerup', () => {
        if (!dragging) return;
        dragging = false;
        box.style.transition = '';
        snapModalToNearestCorner(box);
      });
    }

    function openModal(title) {
      closeModal();
      modalEl = document.createElement('div');
      modalEl.id = 'ytdl-modal-overlay';
      modalEl.innerHTML = `
        <div id="ytdl-modal-box">
          <button class="ytdl-modal-minimize" title="Свернуть">─</button>
          <button class="ytdl-modal-close" title="Скрыть">×</button>
          <button class="ytdl-modal-expand" title="Развернуть">⤢</button>
          <div class="ytdl-modal-title">${title}</div>
          <div class="ytdl-modal-status">Запуск…</div>
          <div class="ytdl-modal-streams"></div>
          <div class="ytdl-modal-actions">
            <button class="ytdl-modal-pause">⏸ Пауза</button>
            <button class="ytdl-modal-cancel">✕ Отмена</button>
          </div>
        </div>
      `;
      document.body.appendChild(modalEl);
      positionModalExpanded();

      modalEl.querySelector('.ytdl-modal-close').addEventListener('click', hideModal);
      modalEl.addEventListener('click', (e) => { if (e.target === modalEl) hideModal(); });

      const box = modalEl.querySelector('#ytdl-modal-box');
      makeModalDraggable(box);
      modalEl.querySelector('.ytdl-modal-minimize').addEventListener('click', () => {
        box.classList.add('ytdl-minimized');
        modalEl.classList.add('ytdl-minimized');
        positionModalMinimized();
      });
      modalEl.querySelector('.ytdl-modal-expand').addEventListener('click', () => {
        box.classList.remove('ytdl-minimized');
        modalEl.classList.remove('ytdl-minimized');
        positionModalExpanded();
      });

      modalEl.querySelector('.ytdl-modal-pause').addEventListener('click', () => {
        if (!activeDownloadController) return;
        if (activeDownloadController.paused) activeDownloadController.resume();
        else activeDownloadController.pause();
        updatePauseButtonLabel();
      });
      modalEl.querySelector('.ytdl-modal-cancel').addEventListener('click', () => {
        if (activeDownloadController) activeDownloadController.cancel();
      });
    }

    function setModalStatus(text) {
      if (!modalEl) return;
      const el = modalEl.querySelector('.ytdl-modal-status');
      if (el) el.textContent = text;
    }

    function formatMb(bytes) {
      return (bytes / (1024 * 1024)).toFixed(2);
    }

    function formatBitrate(bitrateBps) {
      const kbps = (bitrateBps || 0) / 1000;
      if (kbps >= 1024) return (kbps / 1024).toFixed(2) + ' mbps';
      return Math.round(kbps) + ' kbps';
    }

    function formatSize(bytes) {
      if (!bytes) return '? МБ';
      if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' ГБ';
      return (bytes / (1024 * 1024)).toFixed(2) + ' МБ';
    }

    function formatSizePair(receivedBytes, totalBytes) {
      const useGb = totalBytes >= 1024 * 1024 * 1024;
      const div = useGb ? 1024 * 1024 * 1024 : 1024 * 1024;
      const unit = useGb ? 'ГБ' : 'МБ';
      const recv = (receivedBytes / div).toFixed(2);
      const total = totalBytes ? (totalBytes / div).toFixed(2) : '?';
      return { recv, total, unit };
    }

    function updateSpeedTracker(key, receivedBytes) {
      const now = performance.now();
      let t = speedTrackers.get(key);
      if (!t) {
        t = { lastTime: now, lastBytes: receivedBytes, smoothedBps: 0 };
        speedTrackers.set(key, t);
        return 0;
      }
      const dt = (now - t.lastTime) / 1000;
      if (dt >= 0.2) {
        const instantBps = Math.max(0, receivedBytes - t.lastBytes) / dt;
        t.smoothedBps = t.smoothedBps ? (t.smoothedBps * 0.7 + instantBps * 0.3) : instantBps;
        t.lastTime = now;
        t.lastBytes = receivedBytes;
      }
      return t.smoothedBps;
    }

    function formatSpeed(bytesPerSec) {
      const kbit = (Math.max(0, bytesPerSec) * 8) / 1000;
      let value, unit;
      if (kbit >= 1000 * 1000) { value = kbit / (1000 * 1000); unit = 'Гбит/сек'; }
      else if (kbit >= 1000) { value = kbit / 1000; unit = 'Мбит/сек'; }
      else { value = kbit; unit = 'кбит/сек'; }
      return value.toFixed(2).replace('.', ',') + ' ' + unit;
    }

    function formatEta(totalSeconds) {
      if (!isFinite(totalSeconds) || totalSeconds < 0) return '';
      const s = Math.round(totalSeconds);
      const m = Math.floor(s / 60);
      const rem = s % 60;
      return m > 0 ? `${m} мин ${rem} сек` : `${rem} сек`;
    }

    function setStreamProgress(key, label, receivedBytes, totalBytes) {
      if (!modalEl) return;
      const streams = modalEl.querySelector('.ytdl-modal-streams');
      if (!streams) return;

      let row = streams.querySelector(`[data-key="${key}"]`);
      if (!row) {
        row = document.createElement('div');
        row.className = 'ytdl-stream-row';
        row.dataset.key = key;
        row.innerHTML = `
          <div class="ytdl-stream-label"></div>
          <div class="ytdl-progress-track"><div class="ytdl-progress-fill"></div></div>
          <div class="ytdl-stream-speed"></div>
        `;
        streams.appendChild(row);
      }

      const pct = totalBytes ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : 0;
      const { recv, total, unit } = formatSizePair(receivedBytes, totalBytes);
      row.querySelector('.ytdl-stream-label').textContent = `${label}: ${recv}/${total} ${unit} · (${pct}%)`;

      const bps = updateSpeedTracker(key, receivedBytes);
      const speedEl = row.querySelector('.ytdl-stream-speed');
      if (speedEl) {
        if (bps > 0 && totalBytes) {
          const remaining = Math.max(0, totalBytes - receivedBytes);
          const eta = remaining > 0 ? remaining / bps : 0;
          speedEl.textContent = `${formatSpeed(bps)} · ${formatEta(eta)}`;
        } else {
          speedEl.textContent = '0,00 Мбит/сек · 0 мин 0 сек';
        }
      }
      row.querySelector('.ytdl-progress-fill').style.width = pct + '%';
    }

    let menuEl = null;
    let currentAnchor = null;

    function closeMenu() {
      if (menuEl) { menuEl.remove(); menuEl = null; }
      currentAnchor = null;
      document.removeEventListener('click', onOutsideClick, true);
      window.removeEventListener('scroll', onScroll, true);
    }

    function onOutsideClick(e) {
      if (menuEl && !menuEl.contains(e.target)) closeMenu();
    }

    function onScroll() {
      if (menuEl && currentAnchor) positionMenu(currentAnchor);
    }

    function positionMenu(anchor) {
      const rect = anchor.getBoundingClientRect();
      menuEl.style.top = `${Math.round(rect.bottom + 6)}px`;
      let left = Math.round(rect.left);
      const maxLeft = window.innerWidth - 290;
      if (left > maxLeft) left = maxLeft;
      menuEl.style.left = `${Math.max(8, left)}px`;
    }

    async function onQualityPicked(videoFmt, audioFmt) {
      closeMenu();
      openModal('Загрузка видео + аудио');
      const controller = createDownloadController();
      activeDownloadController = controller;
      setStreamProgress('video', 'Видеопоток', 0, videoFmt.contentLength || 0);
      setStreamProgress('audio', 'Аудиопоток', 0, audioFmt.contentLength || 0);
      try {
        const videoDirect = capturedDirectByItag.get(String(videoFmt.itag));
        const audioDirect = capturedDirectByItag.get(String(audioFmt.itag));

        let videoBuf, audioBuf, videoMime, audioMime;

        if (videoDirect && audioDirect) {
          setModalStatus('Загрузка…');
          videoBuf = await downloadDirectSmart(videoDirect.url, (recv, total) => setStreamProgress('video', 'Видеопоток', recv, total), videoFmt.contentLength, controller);
          audioBuf = await downloadDirectSmart(audioDirect.url, (recv, total) => setStreamProgress('audio', 'Аудиопоток', recv, total), audioFmt.contentLength, controller);
          videoMime = videoDirect.mime || videoFmt.mimeType;
          audioMime = audioDirect.mime || audioFmt.mimeType;
        } else {
          setModalStatus('Прямой URL не найден — попытка через SABR…');
          const cfg = buildSabrConfig();

          const sabrStream = new SabrStream({
            serverAbrStreamingUrl: cfg.serverAbrStreamingUrl,
            videoPlaybackUstreamerConfig: cfg.videoPlaybackUstreamerConfig,
            clientInfo: cfg.clientInfo,
            poToken: cfg.poToken,
            formats: cfg.formats,
            durationMs: cfg.durationMs,
            fetch: origFetch ? makeThrottledFetch(500, 'video+audio') : undefined,
          });
          activeSabrStream = sabrStream;
          controller.registerAbort(() => { try { sabrStream.abort(); } catch (e) {} });

          const { videoStream, audioStream, selectedFormats } = await sabrStream.start({
            videoFormat: videoFmt.itag,
            audioFormat: audioFmt.itag,
          });

          setModalStatus('Загрузка через SABR (видео+аудио)…');

          [videoBuf, audioBuf] = await Promise.all([
            readStreamToBuffer(videoStream, (recv, total) => setStreamProgress('video', 'Видеопоток', recv, total), videoFmt.contentLength, 'video', controller),
            readStreamToBuffer(audioStream, (recv, total) => setStreamProgress('audio', 'Аудиопоток', recv, total), audioFmt.contentLength, 'audio', controller),
          ]);
          videoMime = selectedFormats.videoFormat.mimeType || videoFmt.mimeType;
          audioMime = selectedFormats.audioFormat.mimeType || audioFmt.mimeType;
        }

        setModalStatus('Ремукс…');
        const { blob, ext } = await muxVideoAudio(
          videoBuf, videoMime, audioBuf, audioMime,
          (p) => setModalStatus(`Ремукс: ${(p * 100).toFixed(0)}%`)
        );

        await triggerSave(blob, ext);
        setModalStatus(`Готово: ${ext.toUpperCase()}`);
        activeSabrStream = null;
        activeDownloadController = null;
        setTimeout(closeModal, 2000);
      } catch (e) {
        activeDownloadController = null;
        if (e && e.cancelled) {
          console.log('[ytdl] Загрузка отменена пользователем');
          closeModal();
          return;
        }
        console.error('[ytdl]', e);
        setModalStatus('Ошибка: ' + e.message + '\n(Перезагрузите страницу)');
      }
    }

    async function onAudioPicked(audioFmt) {
      closeMenu();
      openModal('Загрузка аудио');
      const controller = createDownloadController();
      activeDownloadController = controller;
      setStreamProgress('audio', 'Аудиопоток', 0, audioFmt.contentLength || 0);
      try {
        let audioBuf, audioMime;
        const direct = capturedDirectByItag.get(String(audioFmt.itag));

        if (direct) {
          setModalStatus('Загрузка напрямую…');
          audioBuf = await downloadDirectSmart(direct.url, (recv, total) => setStreamProgress('audio', 'Аудиопоток', recv, total), audioFmt.contentLength, controller);
          audioMime = direct.mime || audioFmt.mimeType;
        } else {
          setModalStatus('Прямой URL не найден — попытка через SABR…');
          const cfg = buildSabrConfig();

          const sabrStream = new SabrStream({
            serverAbrStreamingUrl: cfg.serverAbrStreamingUrl,
            videoPlaybackUstreamerConfig: cfg.videoPlaybackUstreamerConfig,
            clientInfo: cfg.clientInfo,
            poToken: cfg.poToken,
            formats: cfg.formats,
            durationMs: cfg.durationMs,
            fetch: origFetch ? makeThrottledFetch(500, 'audio-only') : undefined,
          });
          activeSabrStream = sabrStream;
          controller.registerAbort(() => { try { sabrStream.abort(); } catch (e) {} });

          const { audioStream, selectedFormats } = await sabrStream.start({
            audioFormat: audioFmt.itag,
            enabledTrackTypes: GV.Utils.EnabledTrackTypes.AUDIO_ONLY,
          });

          setModalStatus('Загрузка через SABR (аудио)…');
          audioBuf = await readStreamToBuffer(
            audioStream,
            (recv, total) => setStreamProgress('audio', 'Аудиопоток', recv, total),
            audioFmt.contentLength,
            'audio',
            controller
          );
          audioMime = (selectedFormats.audioFormat && selectedFormats.audioFormat.mimeType) || audioFmt.mimeType;
        }

        setModalStatus('Упаковывание…');
        const { blob, ext } = await muxAudioOnly(
          audioBuf, audioMime,
          (p) => setModalStatus(`Упаковывание: ${(p * 100).toFixed(0)}%`)
        );

        await triggerSave(blob, ext);
        setModalStatus(`Готово: ${ext.toUpperCase()}`);
        activeSabrStream = null;
        activeDownloadController = null;
        setTimeout(closeModal, 2000);
      } catch (e) {
        activeDownloadController = null;
        if (e && e.cancelled) {
          console.log('[ytdl] Загрузка отменена пользователем');
          closeModal();
          return;
        }
        console.error('[ytdl]', e);
        setModalStatus('Ошибка: ' + e.message + '\n(Перезагрузите страницу)');
      }
    }

    function showMenuError(text) {
      if (!menuEl) return;
      menuEl.innerHTML = `<div class="ytdl-status">${text}</div>`;
    }

    let tvFetchAttemptedForVideo = null;

    function renderMenu(anchor) {
      const currentVid = getCurrentVideoId();
      if (tvHtml5Formats.length === 0 && tvFetchAttemptedForVideo !== currentVid && currentVid) {
        tvFetchAttemptedForVideo = currentVid;
        fetchTvHtml5FormatsWhenReady(currentVid).then(() => {
          if (menuEl && currentAnchor === anchor) renderMenu(anchor);
        });
      }

      const formats = getAllAvailableFormats();
      if (formats.length === 0) {
        showMenuError('В player response нет adaptiveFormats — видео недоступно?');
        return;
      }

      const allVideo = formats.filter((f) => (f.mimeType || '').startsWith('video/'));
      const video = pickBestPerResolution(allVideo)
        .sort((a, b) => (b.height - a.height) || (b.bitrate - a.bitrate));

      const AUDIO_CODEC_PREFERENCE = { opus: 2, mp4a: 1 };
      const audio = formats.filter((f) => (f.mimeType || '').startsWith('audio/'))
        .sort((a, b) => {
          const rankA = AUDIO_CODEC_PREFERENCE[codecOf(a.mimeType)] || 0;
          const rankB = AUDIO_CODEC_PREFERENCE[codecOf(b.mimeType)] || 0;
          if (rankA !== rankB) return rankB - rankA;
          return b.bitrate - a.bitrate;
        });

      if (video.length === 0 || audio.length === 0) {
        showMenuError('Не найдены отдельные дорожки видео/аудио');
        return;
      }

      const directAudioList = audio.filter((a) => capturedDirectByItag.has(String(a.itag)));
      const bestAudio = directAudioList[0] || audio[0];
      const bestAudioIsDirect = capturedDirectByItag.has(String(bestAudio.itag));

      const comboNote = bestAudioIsDirect
        ? ''
        : ' (Ошибка: перезагрузите страницу)';
      menuEl.innerHTML = `<div class="ytdl-header">Видео + аудио ${Math.round(bestAudio.bitrate / 1000)} kbps${comboNote}:</div>`;
      for (const v of video) {
        const item = document.createElement('div');
        item.className = 'ytdl-item';
        const isVideoDirect = capturedDirectByItag.has(String(v.itag));
        const enabled = isVideoDirect && bestAudioIsDirect;
        const suffix = enabled ? '' : ' (недоступно)';
        const sizeLabel = formatSize(v.contentLength);
        item.innerHTML = `<span>${formatQualityLabel(v)}${suffix}</span><span class="ytdl-badge">${formatBitrate(v.bitrate)} · ${sizeLabel} · ${codecOf(v.mimeType)}</span>`;
        if (enabled) {
          item.addEventListener('click', () => onQualityPicked(v, bestAudio));
        } else {
          item.dataset.disabled = '1';
          item.title = 'Прямая ссылка не найдена для этого качества (или для аудио) — SABR отключён как ненадёжный';
        }
        menuEl.appendChild(item);
      }

      const audioHeader = document.createElement('div');
      audioHeader.className = 'ytdl-header ytdl-header--audio';
      audioHeader.textContent = 'Аудио:';
      menuEl.appendChild(audioHeader);

      for (const a of directAudioList) {
        const item = document.createElement('div');
        item.className = 'ytdl-item';
        const label = a.audioQuality ? a.audioQuality.replace('AUDIO_QUALITY_', '') : `itag ${a.itag}`;
        const sizeLabel = formatSize(a.contentLength);
        item.innerHTML = `<span>${label}</span><span class="ytdl-badge">${formatBitrate(a.bitrate)} · ${sizeLabel} · ${codecOf(a.mimeType)}</span>`;
        item.addEventListener('click', () => onAudioPicked(a));
        menuEl.appendChild(item);
      }
    }

    function openMenu(anchor) {
      closeMenu();
      currentAnchor = anchor;
      menuEl = document.createElement('div');
      menuEl.id = 'ytdl-menu';
      document.body.appendChild(menuEl);
      positionMenu(anchor);

      setTimeout(() => {
        document.addEventListener('click', onOutsideClick, true);
        window.addEventListener('scroll', onScroll, true);
      }, 0);

      renderMenu(anchor);
    }

    let containerMissLogged = false;

    let thanksHideLogged = false;
    function hideThanksButton() {
      const container = document.querySelector('ytd-menu-renderer') || document;

      const candidates = container.querySelectorAll('button, a, [role="button"]');
      for (const el of candidates) {
        const label = (el.getAttribute('aria-label') || el.textContent || '').trim();
        if (/спасибо|thanks/i.test(label)) {
          const host =
            el.closest('yt-button-view-model, ytd-button-renderer, ytd-badge-supported-renderer') || el;
          if (host.isConnected) {
            host.remove();
            if (!thanksHideLogged) {
              thanksHideLogged = true;
              console.log('[ytdl] Удалена из DOM кнопку "Спасибо" — освобождено место, чтобы "Скачать" не уходила в "..."', host);
            }
          }
        }
      }
    }

    let nativeDownloadHideLogged = false;
    function hideNativeDownloadButton() {
      const standalone = document.querySelector('ytd-download-button-renderer');
      const menuVariant = document.querySelector('ytd-menu-service-item-download-renderer');
      const host = standalone || menuVariant;
      if (host && host.isConnected) {
        host.remove();
        if (!nativeDownloadHideLogged) {
          nativeDownloadHideLogged = true;
          console.log('[ytdl] Удалена из DOM родную кнопку "Скачать"', host);
        }
      }
    }

    function ensureOwnButton() {
      if (location.pathname.startsWith('/shorts/')) return;
      if (document.getElementById('ytdl-own-button')) return;
      const container =
        document.querySelector('ytd-watch-metadata #top-level-buttons-computed') ||
        document.querySelector('#actions #top-level-buttons-computed') ||
        document.querySelector('#top-level-buttons-computed');
      if (!container) {
        if (!containerMissLogged) {
          containerMissLogged = true;
          console.warn('[ytdl] Не найден контейнер #top-level-buttons-computed под кнопку — разметка страницы может отличаться (например, в контексте плейлиста), или страница ещё не отрисовалась');
        }
        return;
      }
      if (containerMissLogged) {
        containerMissLogged = false;
        console.log('[ytdl] Контейнер #top-level-buttons-computed наконец найден');
      }

      const btn = document.createElement('button');
      btn.id = 'ytdl-own-button';
      btn.className = 'ytSpecButtonShapeNextHost ytSpecButtonShapeNextTonal ytSpecButtonShapeNextMono ytSpecButtonShapeNextSizeM ytSpecButtonShapeNextIconLeading ytSpecButtonShapeNextEnableBackdropFilterExperiment';
      btn.title = '';
      btn.setAttribute('aria-label', 'Скачать');
      btn.style.marginLeft = '8px';
      btn.innerHTML = `
        <div aria-hidden="true" class="ytSpecButtonShapeNextIcon">
          <span class="ytIconWrapperHost" style="width:24px;height:24px;">
            <span class="yt-icon-shape ytSpecIconShapeHost">
              <div style="width:100%;height:100%;display:block;fill:currentcolor;">
                <svg xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 0 24 24" width="24" focusable="false" aria-hidden="true" style="pointer-events:none;display:inherit;width:100%;height:100%;">
                  <path d="M12 2a1 1 0 00-1 1v11.586l-4.293-4.293a1 1 0 10-1.414 1.414L12 18.414l6.707-6.707a1 1 0 10-1.414-1.414L13 14.586V3a1 1 0 00-1-1Zm7 18H5a1 1 0 000 2h14a1 1 0 000-2Z"></path>
                </svg>
              </div>
            </span>
          </span>
        </div>
        <div class="ytSpecButtonShapeNextButtonTextContent">
          <span class="ytAttributedStringHost ytAttributedStringWhiteSpaceNoWrap" role="text">Скачать</span>
        </div>
      `;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (menuEl) { closeMenu(); return; }
        openMenu(btn);
      });
      container.appendChild(btn);
      console.log('[ytdl] Своя кнопка "Скачать" (в стиле родной) добавлена в', container);
    }

    function ensureShortsDownloadButtons() {
      const bars = document.querySelectorAll('reel-action-bar-view-model');
      for (const bar of bars) {
        if (bar.querySelector('.ytdl-shorts-download-btn')) continue;

        const wrapper = document.createElement('button-view-model');
        wrapper.className = 'ytSpecButtonViewModelHost ytwReelActionBarViewModelHostDesktopActionButton';
        wrapper.innerHTML = `
          <label class="ytSpecButtonShapeWithLabelHost">
            <button class="ytdl-shorts-download-btn ytSpecButtonShapeNextHost ytSpecButtonShapeNextTonal ytSpecButtonShapeNextMono ytSpecButtonShapeNextSizeL ytSpecButtonShapeNextIconButton ytSpecButtonShapeNextEnableBackdropFilterExperiment" title="" aria-label="Скачать" aria-disabled="false">
              <div aria-hidden="true" class="ytSpecButtonShapeNextIcon">
                <span class="ytIconWrapperHost" style="width:24px;height:24px;">
                  <span class="yt-icon-shape ytSpecIconShapeHost">
                    <div style="width:100%;height:100%;display:block;fill:currentcolor;">
                      <svg xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 0 24 24" width="24" focusable="false" aria-hidden="true" style="pointer-events:none;display:inherit;width:100%;height:100%;">
                        <path d="M12 2a1 1 0 00-1 1v11.586l-4.293-4.293a1 1 0 10-1.414 1.414L12 18.414l6.707-6.707a1 1 0 10-1.414-1.414L13 14.586V3a1 1 0 00-1-1Zm7 18H5a1 1 0 000 2h14a1 1 0 000-2Z"></path>
                      </svg>
                    </div>
                  </span>
                </span>
              </div>
            </button>
            <div class="ytSpecButtonShapeWithLabelLabel" aria-hidden="false">
              <span class="ytAttributedStringHost ytAttributedStringWhiteSpacePreWrap ytAttributedStringTextAlignmentCenter ytAttributedStringWordWrapping" role="text" style="">Скачать</span>
            </div>
          </label>
        `;

        const btn = wrapper.querySelector('button');
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (menuEl) { closeMenu(); return; }
          openMenu(btn);
        });

        bar.insertBefore(wrapper, bar.firstChild);
      }
    }

    function scanForButton() {
      hideThanksButton();
      hideNativeDownloadButton();
      ensureOwnButton();
      ensureShortsDownloadButtons();
    }

    let lastVideoId = getCurrentVideoId();

    async function fetchTvHtml5FormatsWhenReady(videoId, maxWaitMs = 8000) {
      const start = Date.now();
      while (Date.now() - start < maxWaitMs) {
        if (uw.ytcfg && typeof uw.ytcfg.get === 'function' && uw.ytcfg.get('INNERTUBE_API_KEY')) {
          return fetchTvHtml5Formats(videoId);
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      console.warn('[ytdl][tv] ytcfg/INNERTUBE_API_KEY так и не появился за', maxWaitMs, 'мс — попытка всё равно (может не сработать)');
      return fetchTvHtml5Formats(videoId);
    }

    new MutationObserver(() => {
      scanForButton();
      const vid = getCurrentVideoId();
      if (vid !== lastVideoId) {
        lastVideoId = vid;
        closeMenu();
        capturedSabr = null;
        capturedDirectByItag.clear();
        tvFetchAttemptedForVideo = null;
        containerMissLogged = false;
        nativeDownloadHideLogged = false;
        if (vid) {
          fetchTvHtml5FormatsWhenReady(vid);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });

    scanForButton();

    if (lastVideoId) {
      fetchTvHtml5FormatsWhenReady(lastVideoId);
    }
  }
})();
