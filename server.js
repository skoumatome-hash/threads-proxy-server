const express = require("express");
const puppeteer = require("puppeteer");
const app = express();

app.use(express.json());

const requestQueue = [];
let isProcessing = false;

// Cookie解析
function parseCookies(input) {
  const cookies = [];
  if (!input) return cookies;
  const trimmed = input.trim();

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        parsed.forEach(c => {
          cookies.push({
            name: c.name,
            value: c.value,
            domain: ".threads.net",
            path: "/",
            secure: true,
            httpOnly: c.httpOnly !== undefined ? c.httpOnly : true
          });
        });
      }
    } catch (e) { console.error("Cookie JSON解析エラー:", e); }
  } else {
    trimmed.split(';').forEach(part => {
      const [key, ...v] = part.trim().split('=');
      if (key && v.length > 0) {
        cookies.push({
          name: key,
          value: v.join('='),
          domain: ".threads.net",
          path: "/",
          secure: true
        });
      }
    });
  }
  return cookies;
}

// プロキシ解析
function parseProxy(proxyStr) {
  if (!proxyStr) return null;
  if (!proxyStr.startsWith("http")) {
    const parts = proxyStr.split(':');
    if (parts.length === 4) {
      return { server: `${parts[0]}:${parts[1]}`, username: parts[2], password: parts[3] };
    }
  }
  try {
    const url = new URL(proxyStr.startsWith("http") ? proxyStr : `http://${proxyStr}`);
    return { server: `${url.hostname}:${url.port}`, username: url.username, password: url.password };
  } catch (e) { return null; }
}

// メイン処理
async function runPuppeteerPost(task) {
  let browser = null;
  try {
    console.log("🚀 ブラウザ起動準備...");
    
    const proxyData = parseProxy(task.proxy);
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--single-process',
      '--no-zygote',
      '--disable-notifications',
      '--window-size=1920,1080'
    ];

    if (proxyData) {
      args.push(`--proxy-server=${proxyData.server}`);
      console.log(`🌐 プロキシ設定: ${proxyData.server}`);
    }

    browser = await puppeteer.launch({ args: args, headless: "new" });
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    if (proxyData && proxyData.username) {
      await page.authenticate({ username: proxyData.username, password: proxyData.password });
    }

    await page.setUserAgent(task.ua || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36");

    const cookies = parseCookies(task.fullCookie);
    if (cookies.length > 0) {
      await page.setCookie(...cookies);
    }

    console.log("🌍 Threadsにアクセス中...");
    await page.goto("https://www.threads.net/", { waitUntil: 'networkidle2', timeout: 90000 });

    // ★修正: 「作成(Create)」ボタンを探してクリックする
    // aria-label="Create" または href="/create" を探す
    console.log("🔍 「作成」ボタンを探しています...");
    
    try {
      // メニューバーが表示されるまで待つ
      await page.waitForSelector('svg[aria-label="Create"], svg[aria-label="作成"]', { timeout: 20000 });
      
      // ボタンをクリック
      const createBtn = await page.$('svg[aria-label="Create"], svg[aria-label="作成"]');
      if (createBtn) {
        console.log("✅ 「作成」ボタンをクリックしました");
        await createBtn.click();
      } else {
        // SVGが見つからない場合、リンクを探す
        console.log("⚠️ SVGが見つかりません。リンクを探します...");
        await page.click('a[href="/create"]');
      }
    } catch (e) {
      // 万が一ボタンが見つからなくても、直接URLを叩いて投稿画面を開く
      console.log("⚠️ ボタンが見つからないため、直接投稿ページへ移動します...");
      await page.goto("https://www.threads.net/create", { waitUntil: 'networkidle2' });
    }

    // 投稿モーダルが開くのを待つ
    console.log("⏳ 投稿入力欄を待機中...");
    const textBoxSelector = 'div[role="textbox"], div[data-lexical-editor="true"]';
    await page.waitForSelector(textBoxSelector, { timeout: 15000 });
    
    // 入力
    console.log("✍️ テキスト入力中...");
    await page.click(textBoxSelector);
    await new Promise(r => setTimeout(r, 1000));
    await page.keyboard.type(task.text, { delay: 100 });
    await new Promise(r => setTimeout(r, 2000));

    // 投稿ボタン (Post) を探してクリック
    console.log("🔘 投稿実行ボタンを探しています...");
    const postBtn = await page.evaluateHandle(() => {
      // "Post" または "投稿" というテキストを持つボタンを探す
      const buttons = Array.from(document.querySelectorAll('div[role="button"]'));
      return buttons.find(b => 
        (b.innerText === "Post" || b.innerText === "投稿") && !b.getAttribute('disabled')
      );
    });

    if (postBtn) {
      await postBtn.click();
      console.log("✅ ボタンをクリックしました！ 完了待ち...");
      await new Promise(r => setTimeout(r, 10000)); // 投稿完了まで十分待つ
      console.log(`🎉 投稿成功: ${task.username}`);
    } else {
      throw new Error("「投稿」ボタンが見つからないか、押せない状態です。");
    }

  } catch (error) {
    console.error(`❌ 処理失敗: ${error.message}`);
    // デバッグ: 失敗時の画面テキストをログに出す
    if (browser) {
      const page = (await browser.pages())[0];
      if (page) {
        const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 300).replace(/\n/g, ' '));
        console.log(`(参考) 画面テキスト: ${bodyText}`);
      }
    }
    throw error;
  } finally {
    if (browser) {
      await browser.close();
      console.log("🔒 ブラウザを閉じました");
    }
  }
}

app.post("/api/check", async (req, res) => {
  res.json({ status: "success", message: "★Puppeteerサーバー稼働中！「投稿」を実行してください。" });
});

app.post("/api/enqueue", (req, res) => {
  const { username, fullCookie, text, deviceId, imageUrl, ua, proxy } = req.body;
  requestQueue.push({ username, fullCookie, text, deviceId, imageUrl, ua, proxy });
  console.log(`[受付] ${username} を予約`);
  res.json({ status: "queued", message: "予約完了" });
  processQueue();
});

async function processQueue() {
  if (isProcessing || requestQueue.length === 0) return;
  isProcessing = true;

  while (requestQueue.length > 0) {
    const task = requestQueue.shift();
    console.log(`\n--- 処理開始 (Puppeteer): ${task.username} ---`);
    try {
      await runPuppeteerPost(task);
    } catch (error) {
      console.error(`❌ 投稿失敗 (${task.username}):`, error.message);
    }
    if (requestQueue.length > 0) {
      console.log("☕ 休憩中...");
      await new Promise((resolve) => setTimeout(resolve, 30000));
    }
  }
  isProcessing = false;
}

const listener = app.listen(process.env.PORT, () => {
  console.log("Server started");
});
