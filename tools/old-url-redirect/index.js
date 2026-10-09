// 旧URL（/mugen-othello/…）を新URL（/mugen-reversi/…）へ恒久的に転送する。
// 「無限オセロ」から「無限リバーシ」に改名したため（「オセロ」は株式会社メガハウスの登録商標）。
// 公開: npx wrangler deploy --config tools/old-url-redirect/wrangler.jsonc
export default {
  fetch(request) {
    const url = new URL(request.url);
    url.pathname = url.pathname.replace(/^\/mugen-othello(?=\/|$)/, '/mugen-reversi');
    return Response.redirect(url.toString(), 301);
  },
};
