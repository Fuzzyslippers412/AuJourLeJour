(() => {
  const PREFIX = "ajl_pwa";

  async function deleteAllDatabases() {
    try {
      const dbs = await indexedDB.databases?.();
      if (Array.isArray(dbs)) {
        await Promise.all(
          dbs
            .map((entry) => entry && entry.name)
            .filter((name) => typeof name === "string" && name.startsWith(PREFIX))
            .map(
              (name) =>
                new Promise((resolve) => {
                  const req = indexedDB.deleteDatabase(name);
                  req.onsuccess = () => resolve();
                  req.onerror = () => resolve();
                  req.onblocked = () => resolve();
                })
            )
        );
        return;
      }
    } catch (err) {
      // ignore
    }
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase(PREFIX);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  }

  async function clean() {
    try {
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((reg) => reg.unregister()));
      }
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      }
      await deleteAllDatabases();
      try {
        window.localStorage.removeItem("ajl_pwa_db_name");
      } catch (err) {
        // ignore
      }
    } catch (err) {
      // ignore
    } finally {
      window.location.replace("/?force=1");
    }
  }

  clean();
})();
