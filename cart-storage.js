// cart-storage.js
// Universal cart storage logic for all pages

function getCart() {
    return JSON.parse(localStorage.getItem('cart') || '[]');
}

function saveCart(cart) {
    localStorage.setItem('cart', JSON.stringify(cart));
}

function addToCart(product) {
    let cart = getCart();
    // Prevent duplicates by title+brand+size (if size exists)
    let found = cart.find(item => item.title === product.title && item.brand === product.brand && (item.size === product.size));
    if (found) {
        found.qty = (found.qty || 1) + (product.qty || 1);
    } else {
        cart.unshift(product); // Add new/different shoes to the top (stack vertically)
    }
    saveCart(cart);
}

function removeFromCart(idx) {
    let cart = getCart();
    cart.splice(idx, 1);
    saveCart(cart);
}

function clearCart() {
    saveCart([]);
}

// Expose globally for inline event handlers
window.getCart = getCart;
window.saveCart = saveCart;
window.addToCart = addToCart;
window.removeFromCart = removeFromCart;
window.clearCart = clearCart;
