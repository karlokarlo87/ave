const express = require('express');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio = require('cheerio');
const fs = require('fs');
const XLSX = require('xlsx');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = 3000;

app.use(express.static('public'));
app.use(express.json());

// Store scraping status
let scrapingStatus = {
    isRunning: false,
    progress: 0,
    totalCategories: 0,
    completedCategories: 0,
    currentCategory: '',
    currentCategoryProgress: '',
    productsFound: 0,
    message: 'Ready to start',
    startTime: null,
    endTime: null,
    duration: null,
    stopRequested: false,
    
    // Shop.aversi.ge tracking
    shopAversi: {
        currentCategory: 0,
        totalCategories: 0,
        currentPage: 0,
        totalPages: 0,
        productsFound: 0
    },
    
    // Aversi.ge (old site) tracking
    oldAversi: {
        currentCategory: 0,
        totalCategories: 0,
        currentPage: 0,
        totalPages: 0,
        productsFound: 0
    }
};

// ============================================
// HELPER FUNCTIONS
// ============================================

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanText(text) {
    if (!text) return '';
    if (typeof text === 'number') return String(text);
    if (typeof text !== 'string') return text;
    
    return text
        .replace(/\r\n/g, ' ')
        .replace(/\n/g, ' ')
        .replace(/\r/g, ' ')
        .replace(/\t/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/\s+#/g, ' #')
        .trim();
}

function cleanPrice(priceText) {
    if (!priceText) return '';

    let price = String(priceText).replace(/\s+/g, '').replace(/₾|ლარი/g, '');

    if (price.includes(',') && !price.includes('.')) {
        price = price.replace(',', '.');
    } else {
        price = price.replace(/,/g, '');
    }

    let priceNumber = parseFloat(price);
    if (isNaN(priceNumber)) return '';

    priceNumber = Math.round(priceNumber * 100) / 100;
    return priceNumber.toFixed(2);
}

async function waitForCloudflare(page) {
    try {
        const title = await page.title();
        
        if (title.includes('Just a moment') || title.includes('Verify you are human')) {
            console.log(`  ⚠️ Cloudflare challenge detected, waiting...`);
            
            await page.waitForFunction(
                () => !document.title.includes('Just a moment') && 
                      !document.title.includes('Verify you are human'),
                { timeout: 30000 }
            ).catch(() => {
                console.log(`  ⚠️ Cloudflare challenge timeout - continuing anyway`);
            });
            
            await delay(3000);
            console.log(`  ✅ Cloudflare challenge passed`);
            return true;
        }
        
        return false;
    } catch (error) {
        console.log(`  ⚠️ Error checking Cloudflare: ${error.message}`);
        return false;
    }
}

async function getOldDataFromJson(newProducts) {
    const jsonPath = path.join(__dirname, 'public', 'data', 'aversi_products.json');
    
    if (fs.existsSync(jsonPath)) {
        const oldData = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        const allProducts = [...oldData, ...newProducts];
        
        console.log(`📊 Total products before deduplication: ${allProducts.length}`);
        
        // Remove duplicates based on productCode
        const uniqueProductsMap = new Map();
        
        allProducts.forEach(product => {
            const key = product.productCode;
            if (key && key.trim() !== '') {
                uniqueProductsMap.set(key, product);
            }
        });
        
        const uniqueProducts = Array.from(uniqueProductsMap.values());
        console.log(`📊 Unique products after deduplication: ${uniqueProducts.length}`);
        
        return uniqueProducts;
    }
    
    return newProducts;
}

function loadCategories() {
    try {
        const categoriesPath = path.join(__dirname, 'public', 'data', 'aversi-farmid.json');
        
        if (fs.existsSync(categoriesPath)) {
            const data = fs.readFileSync(categoriesPath, 'utf-8');
            const categories = JSON.parse(data);
            console.log(`✅ Loaded ${Object.keys(categories).length} FarmID categories`);
            return categories;
        } else {
            console.warn('⚠️ aversi-farmid.json file not found, skipping FarmID scraping');
            return {};
        }
    } catch (error) {
        console.error('❌ Error loading categories:', error.message);
        return {};
    }
}

// ============================================
// SHOP.AVERSI.GE - CATEGORY PAGE SCRAPING
// ============================================

async function downloadPageHTML(browser, category, pageNum, perpage = 192) {
    const url = `${category}page-${pageNum}/?items_per_page=${perpage}&sort_by=product&sort_order=asc`;
    let page;
    
    try {
        page = await browser.newPage();
        
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        });
        
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        });
        
        console.log(`📥 Downloading ${category} page ${pageNum}...`);
        scrapingStatus.message = `Downloading ${category} page ${pageNum}...`;
        
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        await waitForCloudflare(page);
        await delay(3000);
        
        const html = await page.content();
        
        const tempDir = path.join(__dirname, 'temp');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir);
        }
        
        const filename = path.join(tempDir, `page_${pageNum}.html`);
        fs.writeFileSync(filename, html);
        console.log(`✓ Saved: ${filename} (${Math.round(html.length / 1024)} KB)`);
        
        await page.close();
        return filename;
        
    } catch (error) {
        console.error(`✗ Error downloading page ${pageNum}:`, error.message);
        if (page) await page.close();
        return null;
    }
}

function parseHTMLFile(filename, category, pageNum) {
    try {
        console.log(`🔍 Parsing ${path.basename(filename)}...`);
        
        const html = fs.readFileSync(filename, 'utf-8');
        const $ = cheerio.load(html);
        const products = [];
        
        const colTiles = $('.col-tile');
        console.log(`   Found ${colTiles.length} .col-tile elements on page`);
        
        $('.col-tile').each((index, element) => {
            const $el = $(element);
            
            const titleRaw = $el.find('.product-title').text() || '';
            const title = cleanText(titleRaw);
            
            const priceOldRaw = $el.find('.ty-list-price:last-child').text() || '';
            const priceOld = cleanPrice(priceOldRaw);
            
            const priceRaw = $el.find('.ty-price-num').text() || '';
            const price = cleanPrice(priceRaw);
        
            const productCode = $el.find('input[name$="[product_code]"]').val() || ''; 
       
            const product = {
                productCode: cleanText(productCode),
                title: title,
                price: price,
                priceOld: priceOld,
                category: category,
                pageNum: String(pageNum),
                source: 'shop.aversi.ge'
            };
            
            if (title && title.length > 0) {
                products.push(product);
            }
        });
        
        console.log(`   ✓ Extracted ${products.length} valid products`);
        scrapingStatus.productsFound += products.length;
        
        return products;
        
    } catch (error) {
        console.error(`✗ Error parsing ${filename}:`, error.message);
        return [];
    }
}

async function getCategories(browser) {
    let page;
    
    try {
        page = await browser.newPage();
        
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        });
        
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        });
        
        console.log('🔍 Fetching categories from main page...');
        
        await page.goto('https://shop.aversi.ge/ka/', { waitUntil: 'networkidle2', timeout: 60000 });
        await waitForCloudflare(page);
        await delay(3000);
        
        const html = await page.content();
        
        const tempDir = path.join(__dirname, 'temp');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir);
        }
        
        const filename = path.join(tempDir, `categories.html`);
        fs.writeFileSync(filename, html);
        
        await page.close();
        
        const $ = cheerio.load(html);
        const categories = [];
        
        $('.ty-menu__submenu-item .ty-menu__submenu-link').each((i, el) => {
            const href = $(el).attr('href');
            
            if (href && href.includes('/ka/')) {
                const match = href.match(/\/ka\/([^/]+)/);
               
                if (match && match[1]) {
                    if (href.includes('medication')) {
                        if (!href.includes("for-cardiovascular-diseases")) {
                            categories.push({
                                category: href,
                                startPage: 1,
                                endPage: 50,
                                perpage: 192,
                                pages: 50
                            });
                        }
                    }
                }
            }
        });
        
        console.log(`✓ Found ${categories.length} categories from dynamic scraping`);
 
        // Add additional hardcoded categories
        categories.push(
            {category: 'https://shop.aversi.ge/ka/medication/მედიკამენტები-სხვადასხვა/', startPage: 1, endPage: 12, perpage: 192, pages: 12},
            {category: 'https://shop.aversi.ge/ka/medication/homeopathic-remedies/', startPage: 1, endPage: 12, perpage: 192, pages: 12},
            {category: 'https://shop.aversi.ge/ka/medication/for-cardiovascular-diseases/', startPage: 1, endPage: 40, perpage: 24, pages: 40},
            {category: 'https://shop.aversi.ge/ka/medication/various-medicinal-products/', startPage: 1, endPage: 12, perpage: 192, pages: 12},
            {category: 'https://shop.aversi.ge/ka/care-products/child-care/child-care-hygiene-products/', startPage: 1, endPage: 12, perpage: 192, pages: 12},
            {category: 'https://shop.aversi.ge/ka/care-products/oral-care/', startPage: 1, endPage: 12, perpage: 192, pages: 12},
            {category: 'https://shop.aversi.ge/ka/care-products/skin-care-products/', startPage: 1, endPage: 12, perpage: 192, pages: 12},
            {category: 'https://shop.aversi.ge/ka/medication/drugs-stimulating-the-production-of-blood-cells/', startPage: 1, endPage: 12, perpage: 192, pages: 12},
            {category: 'https://shop.aversi.ge/ka/care-products/deodorant-antiperspirant/', startPage: 1, endPage: 12, perpage: 192, pages: 12},
            {category: 'https://shop.aversi.ge/ka/care-products/oral-care/toothpaste/', startPage: 1, endPage: 12, perpage: 192, pages: 12},
            {category: 'https://shop.aversi.ge/ka/care-products/oral-care/denture-adhesive/', startPage: 1, endPage: 12, perpage: 192, pages: 12},
            {category: 'https://shop.aversi.ge/ka/medication/care-items-and-products/care-products-and-equipment/', startPage: 1, endPage: 12, perpage: 192, pages: 12},
            {category: 'https://shop.aversi.ge/ka/care-products/skin-care-products/skin-care-products-ka-17/', startPage: 1, endPage: 12, perpage: 192, pages: 12},
            {category: 'https://shop.aversi.ge/ka/care-products/skin-care-products/skin-care-products-ka-13/', startPage: 1, endPage: 12, perpage: 192, pages: 12}
        );
        
        // Remove duplicates
        const uniqueCategories = categories.filter(
            (item, index, self) =>
                index === self.findIndex(obj => obj.category === item.category)
        );
        
        console.log(`✓ ${uniqueCategories.length} unique categories after deduplication`);
        
        return uniqueCategories;
        
    } catch (error) {
        console.error('❌ Error fetching categories:', error.message);
        if (page) await page.close();
        return [];
    }
}

// ============================================
// AVERSI.GE - FARMID CATEGORY SCRAPING
// ============================================

async function parseCategoryPage(filename, farmID, categoryName) {
    try {
        console.log(`  🔍 Parsing category ${farmID}...`);
        
        const html = fs.readFileSync(filename, 'utf-8');
        const $ = cheerio.load(html);
        const products = [];
        
        const productItems = $('.product-item, .product-card, .product, .item, tr[data-matid]');
        console.log(`     Found ${productItems.length} product elements`);
        
        if (productItems.length > 0) {
            $('.product').each((index, element) => {
                const $el = $(element);
                
                const matID = $el.attr('data-matid') || 
                             $el.find('[data-matid]').attr('data-matid') ||
                             $el.find('a[href*="MatID="]').attr('href')?.match(/MatID=(\d+)/)?.[1];
                
                if (!matID) return;
                
                const titleRaw = $el.find('.product-title').text() || '';
                const title = cleanText(titleRaw);
                
                const priceRaw = $el.find('.price ins').text() || '';
                const price = cleanPrice(priceRaw);
                
                const priceOldRaw = $el.find('.price del').text() || '';
                const priceOld = cleanPrice(priceOldRaw);
                
                if ($el.find('product-title').length > 0) return;

                if (title && title.length > 0) {
                    products.push({
                        productCode: String(matID),
                        title: title,
                        price: price || '',
                        priceOld: priceOld || '',
                        category: `FarmID ${farmID} - ${categoryName}`,
                        pageNum: '',
                        source: 'aversi.ge',
                        farmID: farmID
                    });
                }
            });
        }
        
        console.log(`     ✓ Extracted ${products.length} valid products`);
        scrapingStatus.productsFound += products.length;
        
        return products;
        
    } catch (error) {
        console.error(`  ✗ Error parsing ${filename}:`, error.message);
        return [];
    }
}

async function scrapeCategoriesByFarmID(browser, categories) {
    console.log(`\n🏛️  ═══════════════════════════════════════════════════════`);
    console.log(`🏛️   OLD SITE Category Scraping (aversi.ge)`);
    console.log(`🏛️   Total Categories: ${Object.keys(categories).length}`);
    console.log(`🏛️  ═══════════════════════════════════════════════════════\n`);
    
    const allProducts = [];
    let successCount = 0;
    let failCount = 0;
    let categoryIndex = 0;
    
    const categoryEntries = Object.entries(categories);
    
    for (const [farmID, categoryName] of categoryEntries) {
        categoryIndex++;
        
        if (scrapingStatus.stopRequested) {
            console.log('🛑 Stop requested - halting category scraping');
            break;
        }
        
        console.log(`\n[${categoryIndex}/${categoryEntries.length}] 🏛️ Category: ${farmID} - ${categoryName}`);
        scrapingStatus.currentCategory = `${farmID} - ${categoryName}`;
        
        let page;
        let totalPages = 1;
        
        try {
            // Get pagination info from first page
            page = await browser.newPage();
            
            await page.setViewport({ width: 1920, height: 1080 });
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36');
            
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'ka,en-US;q=0.9,en;q=0.8',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            });
            
            const firstPageUrl = `https://www.aversi.ge/ka/aversi/act/genDet/?FarmID=${farmID}`;
            console.log(`  📥 Downloading first page to check pagination...`);
            
            await page.goto(firstPageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            
            const title = await page.title();
            if (title.includes("Just a moment")) {
                console.log(`  ⚠️ Cloudflare challenge detected, waiting...`);
                await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 120000 }).catch(() => {});
                await delay(3000);
            }
            
            await delay(2000);
            
            totalPages = await page.evaluate(() => {
                const pageLinks = document.querySelectorAll(".pagination li a");
                if (!pageLinks.length) return 1;

                const pageNumbers = Array.from(pageLinks)
                    .map(a => parseInt(a.textContent.trim()))
                    .filter(n => !isNaN(n));

                return pageNumbers.length ? Math.max(...pageNumbers) : 1;
            });
            
            console.log(`  📄 Total pages found: ${totalPages}`);
            await page.close();
            
            // Loop through all pages
            for (let currentPage = 1; currentPage <= totalPages; currentPage++) {
                if (scrapingStatus.stopRequested) {
                    console.log('🛑 Stop requested - halting page scraping');
                    break;
                }
                
                scrapingStatus.message = `Old Site: ${categoryName} - Page ${currentPage}/${totalPages}`;
                scrapingStatus.currentCategoryProgress = `Page ${currentPage}/${totalPages}`;
                
                const url = currentPage === 1 
                    ? `https://www.aversi.ge/ka/aversi/act/genDet/?FarmID=${farmID}`
                    : `https://www.aversi.ge/ka/aversi/act/genDet/?FarmID=${farmID}&page=${currentPage}`;
                
                console.log(`\n  [Page ${currentPage}/${totalPages}] 📥 Downloading from aversi.ge...`);
                
                let pageHandle;
                let filename;
                
                try {
                    pageHandle = await browser.newPage();
                    
                    await pageHandle.setViewport({ width: 1920, height: 1080 });
                    await pageHandle.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36');
                    
                    await pageHandle.setExtraHTTPHeaders({
                        'Accept-Language': 'ka,en-US;q=0.9,en;q=0.8',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Connection': 'keep-alive',
                        'Upgrade-Insecure-Requests': '1'
                    });
                    
                    await pageHandle.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
                    
                    const pageTitle = await pageHandle.title();
                    if (pageTitle.includes("Just a moment")) {
                        console.log(`    ⚠️ Cloudflare challenge detected, waiting...`);
                        await pageHandle.waitForNavigation({ waitUntil: "networkidle2", timeout: 120000 }).catch(() => {});
                        await delay(3000);
                    }
                    
                    await delay(2000);
                    
                    const html = await pageHandle.content();
                    
                    if (html.includes("Please unblock challenges.cloudflare.com")) {
                        console.warn(`    🚫 Blocked by Cloudflare on ${url}`);
                        await pageHandle.close();
                        continue;
                    }
                    
                    const tempDir = path.join(__dirname, 'temp');
                    if (!fs.existsSync(tempDir)) {
                        fs.mkdirSync(tempDir);
                    }
                    
                    filename = path.join(tempDir, `farmid_${farmID}_page_${currentPage}.html`);
                    fs.writeFileSync(filename, html);
                    
                    await pageHandle.close();
                    
                    const products = await parseCategoryPage(filename, farmID, categoryName);
                    
                    if (products && products.length > 0) {
                        allProducts.push(...products);
                        console.log(`    ✅ Page ${currentPage}: ${products.length} products`);
                    } else {
                        console.log(`    ⚠️ Page ${currentPage}: No products found`);
                        if (currentPage > 1) {
                            console.log(`    ℹ️ Stopping pagination for this category`);
                            break;
                        }
                    }
                    
                    try {
                        fs.unlinkSync(filename);
                    } catch (e) {}
                    
                } catch (error) {
                    console.error(`    ✗ Error on page ${currentPage}:`, error.message);
                    if (pageHandle) await pageHandle.close();
                }
                
                if (currentPage < totalPages) {
                    await delay(3000);
                }
            }
            
            successCount++;
            const categoryProducts = allProducts.filter(p => p.farmID === farmID).length;
            console.log(`  ✅ Category Complete: ${categoryProducts} total products from ${totalPages} pages`);
            
        } catch (error) {
            console.error(`  ✗ Error:`, error.message);
            if (page) await page.close();
            failCount++;
        }
        
        if (scrapingStatus.stopRequested) break;
        
        await delay(3000);
    }
    
    console.log(`\n🏛️  ═══════════════════════════════════════════════════════`);
    console.log(`🏛️   OLD SITE Category Scraping Complete!`);
    console.log(`🏛️   Success: ${successCount} categories`);
    console.log(`🏛️   Failed: ${failCount} categories`);
    console.log(`🏛️   Total: ${allProducts.length} products`);
    console.log(`🏛️  ═══════════════════════════════════════════════════════\n`);
    
    return allProducts;
}

// ============================================
// MAIN SCRAPING ORCHESTRATION
// ============================================

async function scrapeAllCategories(browser, categories) {
    scrapingStatus.isRunning = true;
    scrapingStatus.startTime = Date.now();
    scrapingStatus.completedCategories = 0;
    scrapingStatus.totalCategories = categories.length;
    scrapingStatus.productsFound = 0;
    scrapingStatus.progress = 0;
    scrapingStatus.stopRequested = false;
    
    const allProducts = [];
    let successfulPages = 0;
    let failedPages = [];
    let totalPagesScraped = 0;
    
    console.log('📊 Discovered categories:', categories.length);
    
    // Scrape FarmID categories from old site (if available)
    console.log('🔍 Loading FarmID categories...');
    const farmIDCategories = loadCategories();
    
    if (Object.keys(farmIDCategories).length > 0) {
        console.log('🔍 Starting FarmID scraping...');
        const farmIDProducts = await scrapeCategoriesByFarmID(browser, farmIDCategories);
        allProducts.push(...farmIDProducts);
        console.log(`✓ Added ${farmIDProducts.length} FarmID products to results`);
    }
    
    console.log('\n🚀 Starting category scraping (shop.aversi.ge)...');
    
    // Process each category from shop.aversi.ge
    for (let catIndex = 0; catIndex < categories.length; catIndex++) {
        const categoryConfig = categories[catIndex];
        const { category, startPage, endPage, perpage } = categoryConfig;
        
        console.log(`\n╔═══════════════════════════════════════════════════════════╗`);
        console.log(`║  Category [${catIndex + 1}/${categories.length}]: ${category.substring(0, 30).padEnd(30)} ║`);
        console.log(`╚═══════════════════════════════════════════════════════════╝\n`);
        
        scrapingStatus.currentCategory = category;
        scrapingStatus.currentCategoryProgress = `Page 0/${endPage - startPage + 1}`;
        scrapingStatus.completedCategories = catIndex;
        scrapingStatus.progress = Math.round((catIndex / categories.length) * 100);
        
        for (let page = startPage; page <= endPage; page++) {
            const currentPageInCategory = page - startPage + 1;
            const totalPagesInCategory = endPage - startPage + 1;
            
            scrapingStatus.currentCategoryProgress = `Page ${currentPageInCategory}/${totalPagesInCategory}`;
            
            console.log(`\n[Category ${catIndex + 1}/${categories.length}] [Page ${currentPageInCategory}/${totalPagesInCategory}] Processing ${category} page ${page}...`);
            
            const filename = await downloadPageHTML(browser, category, page, perpage);
            
            if (filename) {
                scrapingStatus.message = `Category ${catIndex + 1}/${categories.length} - Page ${currentPageInCategory}/${totalPagesInCategory}`;
                const products = parseHTMLFile(filename, category, page);
                
                console.log(`📦 Parsed ${products.length} products from this page`);
                
                if (products && products.length > 0) {
                    allProducts.push(...products);
                    successfulPages++;
                    totalPagesScraped++;
                    console.log(`✓ Total so far: ${allProducts.length} products from ${successfulPages} pages`);
                    
                    if (products.length < perpage) {
                        console.log(`⚠️ Found ${products.length} < ${perpage} products, stopping this category (reached last page)`);
                        fs.unlinkSync(filename);
                        break;
                    }
                } else {
                    console.log(`✗ No products found on ${category} page ${page} - stopping category`);
                    failedPages.push(`${category}-${page}`);
                    fs.unlinkSync(filename);
                    break;
                }
                
                try {
                    fs.unlinkSync(filename);
                } catch (e) {
                    console.log(`⚠️ Could not delete temp file: ${filename}`);
                }
            } else {
                console.log(`❌ Failed to download page ${page} of ${category}`);
                failedPages.push(`${category}-${page}`);
                break;
            }
            
            if (page < endPage) {
                console.log(`⏳ Waiting 3 seconds...`);
                await delay(3000);
            }
        }
        
        scrapingStatus.completedCategories = catIndex + 1;
        scrapingStatus.progress = Math.round(((catIndex + 1) / categories.length) * 100);
        console.log(`\n✓ Category ${catIndex + 1}/${categories.length} completed! Progress: ${scrapingStatus.progress}%`);
    }
    
    await browser.close();
    
    // Merge with old data and deduplicate
    const finalProducts = await getOldDataFromJson(allProducts);
    
    scrapingStatus.endTime = Date.now();
    scrapingStatus.isRunning = false;
    scrapingStatus.progress = 100;
    
    return {
        allProducts: finalProducts,
        successfulPages,
        failedPages,
        totalPages: totalPagesScraped
    };
}

// ============================================
// EXPRESS ROUTES
// ============================================

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/aversi', async (req, res) => {
    if (scrapingStatus.isRunning) {
        return res.status(400).json({
            error: 'Scraping is already in progress',
            status: scrapingStatus
        });
    }
    
    try {
        const browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
                '--flag-switches-begin --disable-site-isolation-trials --flag-switches-end'
            ],
            ignoreDefaultArgs: ['--enable-automation'],
            ignoreHTTPSErrors: false
        });
        
        const categories = await getCategories(browser);
        
        if (categories.length === 0) {
            return res.status(404).json({ error: 'No categories found' });
        }
        
        const dataDir = path.join(__dirname, 'public', 'data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        
        const jsonPath = path.join(dataDir, 'categories.json');
        fs.writeFileSync(jsonPath, JSON.stringify(categories, null, 2));
        
        res.json({
            message: `Found ${categories.length} categories. Scraping started.`,
            categories: categories,
            status: scrapingStatus
        });
        
        // Run scraping asynchronously
        scrapeAllCategories(browser, categories).then(({ allProducts, successfulPages, failedPages, totalPages }) => {
            const duration = ((scrapingStatus.endTime - scrapingStatus.startTime) / 1000 / 60).toFixed(2);
            
            if (allProducts.length > 0) {
                const cleanedProducts = allProducts.map(product => ({
                    ...product,
                    title: cleanText(product.title),
                    productCode: cleanText(product.productCode),
                    price: cleanPrice(product.price),
                    priceOld: cleanPrice(product.priceOld)
                }));
                
                const jsonPath = path.join(dataDir, 'aversi_products.json');
                fs.writeFileSync(jsonPath, JSON.stringify(cleanedProducts, null, 2));
                
                // Create Excel file
                const workbook = XLSX.utils.book_new();
                
                const allWorksheet = XLSX.utils.json_to_sheet(cleanedProducts);
                XLSX.utils.book_append_sheet(workbook, allWorksheet, 'All Products');
                
                const medications = cleanedProducts.filter(p => p.category && p.category.includes('medication'));
                const medWorksheet = XLSX.utils.json_to_sheet(medications);
                XLSX.utils.book_append_sheet(workbook, medWorksheet, 'Medications');
                
                const careProducts = cleanedProducts.filter(p => p.category && p.category.includes('care-products'));
                const careWorksheet = XLSX.utils.json_to_sheet(careProducts);
                XLSX.utils.book_append_sheet(workbook, careWorksheet, 'Care Products');
                
                const oldSiteProducts = cleanedProducts.filter(p => p.source === 'aversi.ge');
                if (oldSiteProducts.length > 0) {
                    const oldSiteWorksheet = XLSX.utils.json_to_sheet(oldSiteProducts);
                    XLSX.utils.book_append_sheet(workbook, oldSiteWorksheet, 'Old Site Products');
                }
                
                const wscols = [
                    { wch: 15 },  // productCode
                    { wch: 50 },  // title
                    { wch: 15 },  // price
                    { wch: 10 },  // priceOld
                    { wch: 40 },  // category
                    { wch: 10 },  // pageNum
                    { wch: 20 }   // source
                ];
                allWorksheet['!cols'] = wscols;
                medWorksheet['!cols'] = wscols;
                careWorksheet['!cols'] = wscols;
                
                const xlsxPath = path.join(dataDir, 'aversi_products.xlsx');
                XLSX.writeFile(workbook, xlsxPath);
                
                const withPrice = cleanedProducts.filter(p => p.price).length;
                const withDiscount = cleanedProducts.filter(p => p.priceOld && p.priceOld !== p.price).length;
                const withProductCode = cleanedProducts.filter(p => p.productCode).length;
                const fromOldSite = oldSiteProducts.length;
                const fromNewSite = cleanedProducts.filter(p => p.source === 'shop.aversi.ge').length;
                
                scrapingStatus.message = `Completed! Scraped ${cleanedProducts.length} products in ${duration} minutes`;
                scrapingStatus.statistics = {
                    totalProducts: cleanedProducts.length,
                    medicationProducts: medications.length,
                    careProducts: careProducts.length,
                    pagesScraped: successfulPages,
                    failedPages: failedPages.length,
                    duration: duration,
                    withPrice: withPrice,
                    withDiscount: withDiscount,
                    withProductCode: withProductCode,
                    fromOldSite: fromOldSite,
                    fromNewSite: fromNewSite
                };
            } else {
                scrapingStatus.message = 'No products were scraped';
            }
        }).catch(error => {
            console.error('Scraping error:', error);
            scrapingStatus.isRunning = false;
            scrapingStatus.message = `Error: ${error.message}`;
        });
        
    } catch (error) {
        console.error('Error starting scraper:', error);
        res.status(500).json({ 
            error: 'Failed to start scraping',
            details: error.message 
        });
    }
});

app.get('/aversi/status', (req, res) => {
    res.json(scrapingStatus);
});

app.get('/aversi/data', (req, res) => {
    const jsonPath = path.join(__dirname, 'public', 'data', 'aversi_products.json');
    
    if (fs.existsSync(jsonPath)) {
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        res.json({
            success: true,
            count: data.length,
            products: data.slice(0, 100),
            message: `Showing first 100 of ${data.length} products`
        });
    } else {
        res.status(404).json({
            success: false,
            message: 'No data available. Please run the scraper first.'
        });
    }
});

app.get('/aversi/download/json', (req, res) => {
    const filePath = path.join(__dirname, 'public', 'data', 'aversi_products.json');
    if (fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

app.get('/aversi/download/excel', (req, res) => {
    const filePath = path.join(__dirname, 'public', 'data', 'aversi_products.xlsx');
    if (fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

// Clean temp directory on startup
const tempDir = path.join(__dirname, 'temp');
if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
}

app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║         Aversi Pharmacy Scraper Web Service              ║
║                   CLEANED VERSION                        ║
║                                                          ║
║  Server running at: http://localhost:${PORT}             ║
║                                                          ║
║  Scraping from:                                          ║
║  🏛️  aversi.ge - FarmID categories (if configured)      ║
║  🆕 shop.aversi.ge - Main product categories            ║
║                                                          ║
║  API Endpoints:                                          ║
║  GET  /aversi         - Start scraping                   ║
║  GET  /aversi/status  - Check scraping status            ║
║  GET  /aversi/data    - Get scraped data                 ║
║  GET  /aversi/download/json  - Download JSON file        ║
║  GET  /aversi/download/excel - Download Excel file       ║
╚═══════════════════════════════════════════════════════════╝
    `);
});