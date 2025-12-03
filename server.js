const express = require("express");
const { HttpsProxyAgent } = require("https-proxy-agent");
const axios = require("axios");
const app = express();

app.use(express.json());

const requestQueue = [];
let isProcessing = false;

// Cookie値の抽出
function getCookieValue(cookieString, key) {
  if (!cookieString) return null;
  const match = cookieString.match(new RegExp('(^|;\\s*)' + key + '=([^;]*)'));
  if (match && match[2]) return decodeURIComponent(match[2]);
  return null;
}

// プロキシ形式変換
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

// ブラウザ偽装ヘッダー作成
function createWebHeaders(ua, fullCookie, csrftoken) {
  return {
    'User-Agent': ua,
    'Cookie': fullCookie,
    'x-csrftoken': csrftoken,
    'x-ig-app-id': '238260118697367',
    'x-asbd-id': '129477',
    'Authority': 'www.threads.net',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1'
  };
}

// 1. ログイン確認 (HTML解析版)
app.post("/api/check", async (req, res) => {
  const { username, fullCookie, ua, proxy } = req.body;
  console.log(`[Login Check] ${username}`);

  if (!proxy || !fullCookie) return res.status(400).json({ status: "error", message: "情報不足" });

  try {
    const formattedProxy = formatProxy(proxy);
    const proxyAgent = new HttpsProxyAgent(formattedProxy);
    const realCsrf = getCookieValue(fullCookie, "csrftoken");
    const headers = createWebHeaders(ua, fullCookie, realCsrf);

    const targetUrl = `https://www.threads.net/@${username}`;
    
    // HTMLを取得
    const response = await axios.get(targetUrl, {
      httpsAgent: proxyAgent,
      headers: headers,
      proxy: false,
      validateStatus: status => status < 500
    });

    console.log(`Response Status: ${response.status}`);

    if (response.status === 200) {
      // HTMLの中にユーザー名が含まれているかチェック
      // (ログインしていれば、自分のアイコン画像URLや設定データなどが含まれるはず)
      // 簡易チェックとして、レスポンスサイズが十分にあればOKとする
      const htmlLength = response.data.length;
      
      if (htmlLength > 5000) {
         res.json({ status: "success", message: `★ページ取得成功！ (Size: ${htmlLength} bytes)` });
      } else {
         res.json({ status: "success", message: "★通信成功 (ただしページが空に近い)" });
      }
    } else if (response.status === 404) {
      res.status(404).json({ status: "error", message: "ページが見つかりません (404)" });
    } else {
      res.status(response.status).json({ status: "error", message: `ステータス異常: ${response.status}` });
    }

  } catch (error) {
    console.error(`[Login Check] エラー: ${error.message}`);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// 2. 予約受付
app.post("/api/enqueue", (req, res) => {
  const { username, fullCookie, text, deviceId, imageUrl, ua, proxy } = req.body;
  requestQueue.push({ username, fullCookie, text, deviceId, imageUrl, ua, proxy });
  console.log(`[受付] ${username} を予約`);
  res.json({ status: "queued", message: "予約完了" });
  processQueue();
});

// 3. 処理ワーカー (脱ライブラリ・GraphQL投稿版)
// ★前回の投稿成功ロジック(LSD取得→GraphQL)をここに実装します
async function processQueue() {
  if (isProcessing || requestQueue.length === 0) return;
  isProcessing = true;

  while (requestQueue.length > 0) {
    const task = requestQueue.shift();
    console.log(`\n--- 処理開始: ${task.username} ---`);

    try {
      const formattedProxy = formatProxy(task.proxy);
      const proxyAgent = new HttpsProxyAgent(formattedProxy);
      const realCsrf = getCookieValue(task.fullCookie, "csrftoken");
      const userID = getCookieValue(task.fullCookie, "ds_user_id");

      // 1. LSDトークンを取得 (Topページからスクレイピング)
      let headers = createWebHeaders(task.ua, task.fullCookie, realCsrf);
      const pageRes = await axios.get(`https://www.threads.net/@${task.username}`, {
        httpsAgent: proxyAgent,
        headers: headers,
        proxy: false
      });
      
      // LSDを探す
      const lsdMatch = pageRes.data.match(/"LSD",\[\],{"token":"(.*?)"}/);
      const lsd = lsdMatch ? lsdMatch[1] : null;
      
      if (!lsd) throw new Error("LSDトークンが見つかりませんでした");
      console.log(`LSD取得: ${lsd}`);

      // 2. 投稿 (GraphQL)
      // ヘッダーにLSDを追加
      headers['x-fb-lsd'] = lsd;
      headers['x-fb-friendly-name'] = 'BarcelonaCreatePostMutation';

      const postPayload = new URLSearchParams();
      postPayload.append('lsd', lsd);
      postPayload.append('variables', JSON.stringify({
        userID: userID,
        text: task.text,
        publicationOpt: "any_user",
        // 画像がある場合は添付処理が必要ですが、まずはテキスト
        attachmentUtils: null
      }));
      postPayload.append('doc_id', '23980155133315596'); // Web版 CreatePost ID

      const postRes = await axios.post("https://www.threads.net/api/graphql", postPayload, {
        httpsAgent: proxyAgent,
        headers: headers,
        proxy: false
      });

      console.log("投稿レスポンス:", JSON.stringify(postRes.data));
      console.log(`✅ 投稿完了: ${task.username}`);

    } catch (error) {
      console.error(`❌ 投稿失敗 (${task.username}):`, error.message);
      if (error.response) console.log(JSON.stringify(error.response.data));
    }

    if (requestQueue.length > 0) {
      console.log("☕ 休憩中 (25秒)...");
      await new Promise((resolve) => setTimeout(resolve, 25000));
    }
  }
  isProcessing = false;
}

const listener = app.listen(process.env.PORT, () => {
  console.log("Server started");
});
