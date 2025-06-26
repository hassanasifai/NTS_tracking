/* worker.js – just filters by bbox, returns raw points */
let features = [];

self.onmessage = ({ data }) => {
  if (data.type === "seed") {
    features = data.payload;
  } else if (data.type === "query") {
    const [w, s, e, n] = data.payload.bbox;
    self.postMessage(
      features.filter(f => {
        const [lon, lat] = f.geometry.coordinates;
        return lon >= w && lon <= e && lat >= s && lat <= n;
      })
    );
  }
};