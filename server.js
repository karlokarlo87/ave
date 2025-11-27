import cloudflareScraper from 'cloudflare-scraper';
import * as cheerio from 'cheerio';
import fs from 'fs/promises'; // for reading JSON file
import { fileURLToPath } from 'url';
import path from 'path';
import XLSX from 'xlsx';
 
// Read your JSON and loop through FarmIDs
(async () => {
    try {
        // Read JSON file
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);

        const filePath = path.join(__dirname, 'public', 'data', 'aversi-farmid.json');
        const fileData = await fs.readFile(filePath, 'utf-8');
        const farmIds = JSON.parse(fileData); 


        const categoriesFilePath = path.join(__dirname, 'public', 'data', 'categories.json');
        const categoriesData = await fs.readFile(categoriesFilePath, 'utf-8');
        const categories = JSON.parse(categoriesData); 


        const allProducts = [];

        for (const [farmID, categoryName] of Object.entries(farmIds)) {
           
           for (let pageNum = 1; pageNum <= 150; pageNum++) {
             
            const url = `https://www.aversi.ge/ka/aversi/act/genDet/?FarmID=${farmID}&page=${pageNum}`;

                try {
                    const response = await cloudflareScraper.get(url);
                    const products = extractProductsFromHTML(response.body, 'medicines', 1, 'aversi.ge');
                    console.log(`FarmID ${farmID}: Found ${products.length} products`);
                    allProducts.push(...products);
                    delay(3000);
                    if(products.length === 0) {
                        console.log(`FarmID ${farmID}: No more products found at page ${pageNum}. Stopping.`);
                        break; 
                    }                    
                } catch (err) {
                    console.log(`Error fetching FarmID ${farmID}:`, err.message);
                    delay(3000);
                }
            }
        }

                // --- Scrape Category pages ---
        for (const cat of categories) {
            const { category, startPage = 1, endPage = 1,perpage = 192 } = cat;

            for (let page = startPage; page <= endPage; page++) {
                const url = `${category}page-${page}/?items_per_page=${perpage}&sort_by=product&sort_order=asc`;
                try {
                    const response = await cloudflareScraper.get(url);
                    const products = extractProductsFromHTML(response.body, category, page, 'shop.aversi.ge');
                    console.log(`Category ${category}, page ${page}: Found ${products.length} products`);
                    allProducts.push(...products);
                    await delay(2000);
                    if(products.length === 0 || products.length < perpage) {
                       console.log(`Category ${category}: No more products found at page ${page}. Stopping.`);
                        break; 
                    }
                } catch (err) {
                    console.log(`Error fetching category ${category}, page ${page}:`, err.message);
                    await delay(2000);
                }
            }
        }
        // --- Save JSON ---
        const dataDir = path.join(__dirname, 'public', 'data');
        await fs.mkdir(dataDir, { recursive: true });
        const jsonPath = path.join(dataDir, 'aversi-products.json');
        await fs.writeFile(jsonPath, JSON.stringify(allProducts, null, 2));

        // --- Save Excel ---
        saveToExcel(allProducts, dataDir);
        console.log('All products scraped:', allProducts.length);
        // Optionally save to a file
        await fs.writeFile('aversi-products.json', JSON.stringify(allProducts, null, 2));
    } catch (err) {
        console.error('Error reading JSON or scraping:', err);
    }
})();

function extractProductsFromHTML(html, category, pageNum = 1, source = 'shop.aversi.ge') {
    const $ = cheerio.load(html);
    const products = [];
    
    if (source === 'shop.aversi.ge') {
        $('.col-tile').each((index, element) => {
            const $el = $(element);
            
            const titleRaw = $el.find('.product-title').text() || '';
            const title = cleanText(titleRaw);
            
            const priceOldRaw = $el.find('.ty-list-price:last-child').text() || '';
            const priceOld = cleanPrice(priceOldRaw);
            
            const priceRaw = $el.find('.ty-price-num').text() || '';
            const price = cleanPrice(priceRaw);
            
            const productCode = $el.find('input[name$="[product_code]"]').val() || 
                               $el.find('[data-product-code]').attr('data-product-code') || '';
            
            const product = {
                productCode: cleanText(productCode),
                title: title,
                price: price,
                priceOld: priceOld,
                category: category,
                pageNum: String(pageNum),
                source: source,
                timestamp: new Date().toISOString()
            };
            
            if (title && title.length > 0) {
                products.push(product);
            }
        });
    } else if (source === 'aversi.ge') {
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
            
            if (title && title.length > 0) {
                products.push({
                    productCode: String(matID),
                    title: title,
                    price: price || '',
                    priceOld: priceOld || '',
                    category: category,
                    pageNum: String(pageNum),
                    source: source,
                    timestamp: new Date().toISOString()
                });
            }
        });
    }
    
    return products;
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

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
// --- Excel saving ---
function saveToExcel(products, dataDir) {

    
    
    // Remove duplicates by productCode
    const uniqueProductsMap = new Map();
    products.forEach(p => { if (p.productCode) uniqueProductsMap.set(p.productCode, p); });
    const uniqueProducts = Array.from(uniqueProductsMap.values());

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(uniqueProducts), 'All Products');

    const meds = uniqueProducts.filter(p => p.category?.toLowerCase().includes('medication'));
    if (meds.length) XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(meds), 'Medications');

    const care = uniqueProducts.filter(p => p.category?.toLowerCase().includes('care'));
    if (care.length) XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(care), 'Care Products');

    const shop = uniqueProducts.filter(p => p.source === 'shop.aversi.ge');
    if (shop.length) XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(shop), 'Shop Aversi');

    const old = uniqueProducts.filter(p => p.source === 'aversi.ge');
    if (old.length) XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(old), 'Old Aversi');

    const wscols = [
        {wch:20},{wch:60},{wch:12},{wch:12},{wch:50},{wch:10},{wch:15},{wch:25}
    ];
    workbook.SheetNames.forEach(name => { workbook.Sheets[name]['!cols'] = wscols; });

    const xlsxPath = path.join(dataDir, 'aversi-products.xlsx');
    XLSX.writeFile(workbook, xlsxPath);

    console.log(`\n✅ Excel saved: ${xlsxPath}`);
}