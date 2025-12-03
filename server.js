const express = require("express");
const { ThreadsAPI } = require("threads-api");
const { HttpsProxyAgent } = require("https-proxy-agent");
const axios = require("axios");
const app = express();

app.use(express.json());

const requestQueue = [];
let isProcessing = false;

// ---------------------------------------------------------
//  Cookie文字列から値を抜き出す関数
// ---------------------------------------------------------
function getCookieValue(cookieString, key) {
  if (!cookieString) return null;
  const match = cookieString.match(new RegExp('(^|;\\s*)' + key + '=([^;]*)'));
  if (match && match[2]) return decodeURIComponent(match[2]);
  return null;
}

// ---------------------------------------------------------
//  プロキシ形式変換
// ---------------------------------------------------------
function formatProxy(proxyStr) {
  if (!proxyStr) return null;
  if (proxyStr.startsWith("http")) return proxyStr;
  const parts = proxyStr.split(':');
  if (parts.length === 4) {
    const [host, port, user, pass] = parts;
    return `http://${user}:${pass}@${host}:${port}`;
  }
  return proxyStr;
}

// 1. ログイン確認 (ブラウザ完全偽装版)
app.post("/api/check", async (req, res) => {
  const { username, fullCookie, ua, proxy } = req.body;
  console.log(`[Login Check] ${username}`);

  if (!proxy || !fullCookie) {
    return res.status(400).json({ status: "error", message: "情報不足" });
  }

  try {
    const formattedProxy = formatProxy(proxy);
    const proxyAgent = new HttpsProxyAgent(formattedProxy);
    const realCsrf = getCookieValue(fullCookie, "csrftoken");

    // ★修正: ブラウザになりきるための完全なヘッダー
    const headers = {
      'User-Agent': ua,
      'Cookie': fullCookie,
      'x-csrftoken': realCsrf,
      'x-ig-app-id': '238260118697367',
      'x-asbd-id': '129477',
      // ▼▼ ここから追加したブラウザ用ヘッダー ▼▼
      'Authority': 'www.threads.net',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none', // 直接アクセスを装う
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1'
    };

    // Threadsのトップページ（またはプロフィール）を見に行く
    // ※APIではなくHTMLページを見に行くことで、より自然なアクセスにする
    const targetUrl = `https://www.threads.net/@${username}`;

    const response = await axios.get(targetUrl, {
      httpsAgent: proxyAgent,
      headers: headers,
      proxy: false, // axios標準のプロキシ機能を切ってhttpsAgentを使う
      validateStatus: function (status) {
        return status >= 200 && status < 500; // 404などはエラーにしない
      }
    });

    console.log(`Response Status: ${response.status}`);

    // 200 OK なら通信成功
    // さらに、レスポンスのHTMLの中に「ログアウト」などの文字がないか簡易チェック
    if (response.status === 200) {
      // ログインできているかどうかの判定（簡易）
      // タイトルタグなどにユーザー名が含まれているかチェック
      if (response.data.includes(username)) {
        res.json({ status: "success", message: `★ログイン確認よし！ (Profile Page 200 OK)` });
      } else {
        // 200だけど中身がログインページかもしれない
        res.json({ status: "success", message: `★通信成功 (Status 200) ※念のため投稿テスト推奨` });
      }
    } else if (response.status === 404) {
      res.status(404).json({ status: "error", message: "ページが見つかりません (404)。ユーザー名が正しいか確認してください。" });
    } else {
      res.status(response.status).json({ status: "error", message: `ステータス異常: ${response.status}` });
    }

  } catch (error) {
    console.error(`[Login Check] 通信失敗: ${error.message}`);
    
    if (error.response) {
      console.log(`Status: ${error.response.status}`);
      // HTMLが返ってきている場合、ログに出すと長すぎるので先頭だけ
      // console.log(error.response.data.substring(0, 200));
      
      const status = error.response.status;
      if (status === 403 || status === 401) {
         return res.status(403).json({ status: "error
