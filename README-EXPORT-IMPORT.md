Export / Import localStorage (shoe-pao-storage.json)

This repository contains a static demo site that stores runtime state in the browser's localStorage keys such as `users`, `inventory`, `orders`, and `profile`.

Purpose
- Allow teams to share the same runtime data between devices by exporting localStorage into a JSON file (`shoe-pao-storage.json`) and committing it to the repo or sharing it directly.

How it works (manual flow)
1. On Device A (source):
   - Open the site in a browser and run the Export Storage button on the Inventory page (Inventory → Export Storage). This downloads `shoe-pao-storage.json` containing selected keys.
   - Alternatively, open DevTools → Console and run the export snippet (see below) to download the JSON.

2. Add the exported file to the repository (optional):
   - Move `shoe-pao-storage.json` into the project folder and commit it so others can pull it:

```powershell
cd C:\xampp\htdocs\SHOEPAO
git add shoe-pao-storage.json
git commit -m "chore: add exported runtime storage (shoe-pao-storage.json)"
git push origin main
```

3. On Device B (destination):
   - Pull or download the `shoe-pao-storage.json` file from the repo or get it via direct file transfer.
   - Open the site in the browser and use the Inventory → Import Storage button to pick the file. The script will write the keys into localStorage and reload the page.

Security & notes
- The exported JSON contains raw localStorage values. If `users` contains plaintext passwords, these are included. Do not commit this file to a public repository if it contains sensitive data.
- Importing will overwrite the corresponding keys in the destination browser. Back up before importing if needed.
- For production-grade sync use a server or a secure cloud DB. This file-based flow is a manual, developer-friendly solution for demos and local testing.

DevTools export/import snippets
- Export snippet (run in Console to download file):
```javascript
(function(){
  const keys = ['users','inventory','orders','profile','cart'];
  const data = {}; keys.forEach(k => { data[k] = localStorage.getItem(k); });
  const blob = new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'shoe-pao-storage.json'; document.body.appendChild(a); a.click(); URL.revokeObjectURL(url); a.remove();
})();
```

- Import snippet (run in Console to pick and import a file):
```javascript
(function(){
  const input = document.createElement('input'); input.type='file'; input.accept='application/json';
  input.onchange = e => { const file = e.target.files[0]; const reader=new FileReader(); reader.onload = ()=>{ const data=JSON.parse(reader.result); Object.keys(data).forEach(k=>{ if(data[k]!==null) localStorage.setItem(k,data[k]); }); alert('Imported storage. Reloading...'); location.reload(); }; reader.readAsText(file); };
  input.click();
})();
```

If you'd like, I can:
- Add a small admin page that can host and version these exports safely.
- Add merge logic instead of overwrite so imports can merge specific keys.
- Add CI automation to publish a storage file from a secure machine.

