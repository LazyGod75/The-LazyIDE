export default function debounce(fn, delayMs) {
  let timer;
  return function (...args) {
    fn(...args);  // BUG: fires immediately
    timer = setTimeout(() => {}, delayMs);
  };
}
