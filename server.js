const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const Jimp = require('jimp');
const AdmZip = require('adm-zip');
const sanitize = require('sanitize-filename');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = 3456;
const DATA_DIR = path.join(__dirname, 'data', 'arts');

const novelDB = new Map();
const comicDB = new Map();
const taskQueue = new Map();
let isReady = false;

const MAX_CONCURRENT_DOWNLOADS = 5;
const TASK_TIMEOUT = 20 * 60 * 1000;
const CLEANUP_INTERVAL = 5 * 60 * 1000;
const MAX_IMAGE_WIDTH = 1000;

async function buildIndex() {
  try {
    const files = (await fs.readdir(DATA_DIR)).filter(f => f.endsWith('.json'));
    console.log(`[初始化] 发现 ${files.length} 个JSON文件`);
    
    for (const file of files) {
      try {
        const content = await fs.readFile(path.join(DATA_DIR, file), 'utf-8');
        const data = JSON.parse(content);
        const id = parseInt(data.id);
        if (!id || isNaN(id)) continue;
        
        const hasImages = Array.isArray(data.content_imgs) && 
                         data.content_imgs.length > 0 && 
                         typeof data.content_imgs[0] === 'string' &&
                         data.content_imgs[0].startsWith('http');
        
        const hasText = typeof data.content_text === 'string' && 
                       data.content_text.trim().length > 0;
        
        if (hasImages) {
          comicDB.set(id, {
            id, name: data.name || '', type_name: data.type_name || '',
            collect_time: data.collect_time, source_name: data.source_name,
            content_imgs: data.content_imgs, total_images: data.content_imgs.length
          });
        } else if (hasText) {
          novelDB.set(id, {
            id, name: data.name || '', type_name: data.type_name || '',
            collect_time: data.collect_time, source_name: data.source_name,
            content_text: data.content_text
          });
        }
      } catch (e) {}
    }
    
    console.log(`[初始化] 完成: ${novelDB.size} 部小说, ${comicDB.size} 部漫画`);
    isReady = true;
    setInterval(cleanupTasks, CLEANUP_INTERVAL);
  } catch (err) {
    console.error('[初始化] 失败:', err);
    process.exit(1);
  }
}

function cleanupTasks() {
  const now = Date.now();
  for (const [taskId, task] of taskQueue.entries()) {
    if (now - task.created_at > TASK_TIMEOUT) taskQueue.delete(taskId);
  }
}

app.use((req, res, next) => {
  if (isReady) return next();
  res.status(503).json({ code: 503, message: '服务初始化中...' });
});

async function downloadImage(url, retries = 2) {
  try {
    const response = await axios({
      url, method: 'GET', responseType: 'arraybuffer', timeout: 30000,
      maxContentLength: 15 * 1024 * 1024,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'image/*,*/*;q=0.8'
      }
    });
    
    const buffer = Buffer.from(response.data);
    if (buffer.length < 100) throw new Error('Image too small');
    
    const image = await Jimp.read(buffer);
    
    if (image.getWidth() > MAX_IMAGE_WIDTH) {
      image.resize(MAX_IMAGE_WIDTH, Jimp.AUTO);
    }
    
    return { 
      success: true, 
      image, 
      width: image.getWidth(), 
      height: image.getHeight() 
    };
  } catch (err) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 800));
      return downloadImage(url, retries - 1);
    }
    return { success: false, error: err.message };
  }
}

async function generatePlaceholder(width, height, pageNum, total) {

  const image = new Jimp(width, height, 0xeeeeee);
  
  try {
    const font = await Jimp.loadFont(Jimp.FONT_SANS_32_BLACK);
    const fontSmall = await Jimp.loadFont(Jimp.FONT_SANS_16_BLACK);
    
    image.print(font, 0, height/2 - 40, {
      text: '⚠️ 图片失效',
      alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER,
      alignmentY: Jimp.VERTICAL_ALIGN_MIDDLE
    }, width, height);
    
    image.print(fontSmall, 0, height/2 + 20, {
      text: `第 ${pageNum} / ${total} 页`,
      alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER
    }, width, 40);
    
  } catch (err) {
    console.log('[占位图] 字体绘制失败:', err.message);
  }
  
  return image;
}

async function processLongImageTask(taskId, comicData) {
  const task = taskQueue.get(taskId);
  if (!task) return;
  
  try {
    console.log(`[任务 ${taskId}] 开始处理 "${comicData.name || '未命名'}"`);
    task.status = 'downloading';
    
    const urls = comicData.content_imgs;
    const total = urls.length;
    const results = [];
    
    console.log(`[任务 ${taskId}] 下载 ${total} 张图片...`);
    for (let i = 0; i < total; i += MAX_CONCURRENT_DOWNLOADS) {
      const batch = urls.slice(i, i + MAX_CONCURRENT_DOWNLOADS);
      
      const batchResults = await Promise.all(
        batch.map((url, idx) => downloadImage(url).then(result => ({
          index: i + idx,
          result
        })))
      );
      
      results.push(...batchResults);
      task.progress = Math.round((results.length / total) * 40);
    }
    
    const successCount = results.filter(r => r.result.success).length;
    const failCount = total - successCount;
    console.log(`[任务 ${taskId}] 下载完成: ${successCount} 成功, ${failCount} 失败`);
    
    task.status = 'processing';
    const processedImages = [];
    
    for (let i = 0; i < total; i++) {
      const item = results.find(r => r.index === i);
      
      if (item.result.success) {
        processedImages.push({
          image: item.result.image,
          height: item.result.height
        });
      } else {
        const placeholder = await generatePlaceholder(MAX_IMAGE_WIDTH, 600, i + 1, total);
        processedImages.push({
          image: placeholder,
          height: 600,
          isPlaceholder: true
        });
      }
    }
    
    console.log(`[任务 ${taskId}] 拼接长图...`);
    task.status = 'compositing';
    
    const totalHeight = processedImages.reduce((sum, img) => sum + img.height, 0);
    
    const longImage = new Jimp(MAX_IMAGE_WIDTH, totalHeight, 0xffffff);
    
    let currentY = 0;
    for (let i = 0; i < processedImages.length; i++) {
      const { image, height } = processedImages[i];
      
      longImage.composite(image, 0, currentY);
      
      try {
        const font = await Jimp.loadFont(Jimp.FONT_SANS_14_BLACK);
        longImage.print(font, MAX_IMAGE_WIDTH - 100, currentY + height - 30, `${i+1}/${total}`);
      } catch(e) {}
      
      currentY += height;
      task.progress = 70 + Math.round(((i + 1) / total) * 20);
    }
    
    console.log(`[任务 ${taskId}] 导出 JPEG...`);
    const jpegBuffer = await longImage.getBufferAsync(Jimp.MIME_JPEG);
    
    task.status = 'packaging';
    const zip = new AdmZip();
    const safeName = sanitize((comicData.name || 'comic').toString()).replace(/\s+/g, '_');
    
    zip.addFile(`${safeName}_长图.jpg`, jpegBuffer);
    
    const info = [
      `漫画名称: ${comicData.name || '未命名'}`,
      `总页数: ${total}`,
      `成功: ${successCount} 页`,
      `失效: ${failCount} 页（已占位）`,
      `尺寸: ${MAX_IMAGE_WIDTH} x ${totalHeight}`,
      `生成时间: ${new Date().toLocaleString()}`
    ].join('\n');
    
    zip.addFile('说明.txt', Buffer.from(info, 'utf-8'));
    const zipBuffer = zip.toBuffer();
    
    task.buffer = zipBuffer;
    task.filename = `${safeName}_${comicData.id}.zip`;
    task.success_count = successCount;
    task.fail_count = failCount;
    task.file_size_mb = (zipBuffer.length / 1024 / 1024).toFixed(2);
    task.status = 'completed';
    task.completed_at = Date.now();
    
    console.log(`[任务 ${taskId}] ✅ 完成! ${task.file_size_mb} MB`);
    
  } catch (error) {
    console.error(`[任务 ${taskId}] ❌ 失败:`, error.message);
    task.status = 'failed';
    task.error = error.message;
    task.buffer = null;
  }
}

function paginate(dataArray, page, pageSize) {
  const total = dataArray.length;
  const currentPage = Math.max(1, parseInt(page) || 1);
  const size = Math.min(parseInt(pageSize) || 20, 100);
  const start = (currentPage - 1) * size;
  
  return {
    list: dataArray.slice(start, start + size),
    pagination: {
      total, page: currentPage, page_size: size,
      total_pages: Math.ceil(total / size),
      has_next: currentPage < Math.ceil(total / size),
      has_prev: currentPage > 1
    }
  };
}

app.get('/', async (req, res) => {
  const { type, name, page, size, keyword } = req.query;
  
  if (type === 'list' && name === '小说') {
    let novels = Array.from(novelDB.values()).map(({ id, name, type_name, collect_time }) => ({
      id, name, type_name, collect_time
    }));
    if (keyword) novels = novels.filter(n => n.name?.toLowerCase().includes(keyword.toLowerCase()));
    return res.json({ code: 0, ...paginate(novels, page, size) });
  }
  
  if (type === 'list' && name === '漫画') {
    let comics = Array.from(comicDB.values()).map(({ id, name, type_name, total_images }) => ({
      id, name, type_name, total_images
    }));
    if (keyword) comics = comics.filter(c => c.name?.toLowerCase().includes(keyword.toLowerCase()));
    return res.json({ code: 0, ...paginate(comics, page, size) });
  }
  
  res.json({
    code: 0,
    message: '漫画小说服务',
    stats: { novels: novelDB.size, comics: comicDB.size },
    usage: {
      '列表': '/?type=list&name=漫画&page=1',
      '下载小说': '/download-novel?id=7184',
      '创建长图任务': '/create-task?id=71807',
      '查询进度': '/task-status?task_id=xxx',
      '下载ZIP': '/download-zip?task_id=xxx'
    }
  });
});

app.get('/download-novel', async (req, res) => {
  const { id } = req.query;
  const novel = novelDB.get(parseInt(id));
  if (!novel) return res.status(404).json({ code: 404, error: '未找到该小说' });
  
  const content = `标题：${novel.name || '未命名'}\n来源：${novel.source_name || '未知'}\n\n${novel.content_text || ''}`;
  const filename = `${sanitize((novel.name || 'novel').toString())}_${id}.txt`;
  
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(content);
});

app.get('/create-task', async (req, res) => {
  const { id } = req.query;
  const comicId = parseInt(id);
  
  if (isNaN(comicId)) return res.status(400).json({ code: 400, error: '无效ID' });
  
  const comic = comicDB.get(comicId);
  if (!comic || !comic.content_imgs?.length) return res.status(404).json({ code: 404, error: '未找到漫画或没有图片' });
  
  const taskId = uuidv4();
  taskQueue.set(taskId, {
    id: taskId, comic_id: comicId, comic_name: comic.name,
    status: 'pending', progress: 0,
    total_images: comic.content_imgs.length,
    created_at: Date.now(),
    buffer: null, filename: null, error: null
  });
  
  setImmediate(() => processLongImageTask(taskId, comic));
  
  res.json({
    code: 0,
    task_id: taskId,
    message: '任务创建成功',
    check_url: `/task-status?task_id=${taskId}`,
    download_url: `/download-zip?task_id=${taskId}`
  });
});

app.get('/task-status', (req, res) => {
  const { task_id } = req.query;
  const task = taskQueue.get(task_id);
  
  if (!task) return res.status(404).json({ code: 404, error: '任务不存在' });
  
  if (task.status === 'completed') {
    return res.json({
      code: 0,
      status: 'completed',
      download_url: `/download-zip?task_id=${task_id}`,
      file_size_mb: task.file_size_mb,
      success_images: task.success_count,
      failed_images: task.fail_count
    });
  }
  
  res.json({
    code: 0,
    status: task.status,
    progress: task.progress,
    message: task.status === 'failed' ? task.error : '处理中...'
  });
});

app.get('/download-zip', (req, res) => {
  const { task_id } = req.query;
  const task = taskQueue.get(task_id);
  
  if (!task || task.status !== 'completed') {
    return res.status(400).json({ code: 400, error: '任务未完成或不存在' });
  }
  
  if (!task.buffer || task.buffer.length === 0) {
    return res.status(500).json({ code: 500, error: '文件生成异常' });
  }
  
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(task.filename)}`);
  res.setHeader('Content-Length', task.buffer.length);
  res.end(task.buffer);
});

(async () => {
  await buildIndex();
  app.listen(PORT, () => {
    console.log(`\n✅ 服务就绪: http://localhost:${PORT}`);
    console.log(`\n使用流程：/create-task?id=xxx -> /task-status?task_id=xxx -> /download-zip?task_id=xxx`);
  });
})();