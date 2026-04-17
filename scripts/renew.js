const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// 环境变量获取
const EMAIL = process.env.H2P_EMAIL;
const PASSWORD = process.env.H2P_PASSWORD;
const TARGET_URL = process.env.RENEW_URL;
const PROXY_JSON = process.env.PROXY_JSON;

const EXTENSION_PATH = path.join(__dirname, 'extensions', 'nopecha', 'unpacked');

async function startProxy() {
    console.log('[初始化] 准备 Hysteria2 代理配置...');
    fs.writeFileSync('config.json', PROXY_JSON);

    console.log('[Hysteria2] starts...');
    const hysteria = spawn('hysteria', ['-c', 'config.json']);
    
    hysteria.stdout.on('data', (data) => console.log(`[Hysteria2 Log]: ${data}`));
    hysteria.stderr.on('data', (data) => console.error(`[Hysteria2 Error]: ${data}`));

    // 等待代理启动
    await new Promise(resolve => setTimeout(resolve, 5000));
    console.log('[Hysteria2] socks5: 127.0.0.1:10808 预计已就绪');
    return hysteria;
}

async function run() {
    let proxyProcess;
    if (PROXY_JSON) {
        proxyProcess = await startProxy();
    }

    console.log('[Playwright] 启动中...');
    const userDataDir = '/tmp/playwright_user_data';
    
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false, // 必须为 false 才能加载扩展，Actions 中由 xvfb 提供虚拟显示器
        proxy: { server: 'socks5://127.0.0.1:10808' },
        args: [
            `--disable-extensions-except=${EXTENSION_PATH}`,
            `--load-extension=${EXTENSION_PATH}`,
            '--no-sandbox',
            '--disable-setuid-sandbox'
        ]
    });

    const page = await context.newPage();
    console.log('[浏览器] 启动完成...');

    try {
        // 1. 访问登录页
        console.log('[页面] 访问登录页面...');
        await page.goto('https://host2play.gratis/login', { timeout: 60000 });
        
        // 2. 填写账号密码
        await page.fill('input[type="email"], input[name="email"]', EMAIL);
        await page.fill('input[type="password"], input[name="password"]', PASSWORD);
        
        console.log('[交互] 等待 NopeCHA 自动处理验证码 (如有) 并点击登录...');
        // 等待足够的时间让插件绕过 CF/Captcha
        await page.waitForTimeout(10000); 
        await page.click('button[type="submit"], button:has-text("Login")');

        // 3. 等待登录成功并跳转
        await page.waitForNavigation({ timeout: 60000 }).catch(() => {});
        console.log('[页面] 登录判定完成，跳转至面板...');

        // 4. 访问续期目标机器面板
        await page.goto(TARGET_URL, { timeout: 60000 });
        await page.waitForTimeout(5000); // 等待页面元素加载

        // 5. 点击 Renew 按钮
        console.log('[交互] 查找并点击 Renew 按钮...');
        const renewButton = page.locator('button:has-text("Renew"), a:has-text("Renew")').first();
        if (await renewButton.isVisible()) {
            await renewButton.click();
            console.log('[成功] 续期按钮已点击！');
            await page.waitForTimeout(3000); // 等待反馈弹窗
        } else {
            console.log('[跳过] 未找到 Renew 按钮，可能尚未到续期时间。');
        }

        // 6. 截图留存验证
        await page.screenshot({ path: path.join(__dirname, 'screenshots', 'renew_done.png'), fullPage: true });
        console.log('[截图] 已保存到 screenshots/renew_done.png');

    } catch (error) {
        console.error('[错误] 运行中断:', error);
        await page.screenshot({ path: path.join(__dirname, 'screenshots', 'error.png') });
    } finally {
        await context.close();
        if (proxyProcess) proxyProcess.kill();
        console.log('[结束] 任务完成，清理进程。');
    }
}

run();
