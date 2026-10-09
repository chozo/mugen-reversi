// 旧URL（/mugen-othello/…）を新URL（/mugen-reversi/…）へ恒久的に転送する。
// 「無限オセロ」から「無限リバーシ」に改名したため（「オセロ」は株式会社メガハウスの登録商標）。
// 公開: npx wrangler deploy --config tools/old-url-redirect/wrangler.jsonc
export default {
  fetch(request) {
    const url = new URL(request.url);
    // 末尾スラッシュなしの /mugen-othello は、転送を1回で済ませるため /mugen-reversi/ へ
    url.pathname = url.pathname === '/mugen-othello' ? '/mugen-reversi/' : url.pathname.replace(/^\/mugen-othello\//, '/mugen-reversi/');
    return Response.redirect(url.toString(), 301);
  },
};
