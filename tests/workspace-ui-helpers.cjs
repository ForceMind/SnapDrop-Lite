'use strict';

async function openMore(page) {
    if (!await page.locator('#moreActions').evaluate(element => element.open))
        await page.locator('#moreToggle').click();
}
async function openJoin(page) {
    if (await page.locator('#joinRow').isHidden()) await page.locator('#toggleJoin').click();
}
async function openRecovery(page) {
    const options = page.locator('#recoveryReceiveOptions');
    await options.waitFor({ state: 'visible', timeout: 15000 });
    if (!await options.evaluate(element => element.open)) await options.locator('summary').click();
}
module.exports = { openMore, openJoin, openRecovery };
