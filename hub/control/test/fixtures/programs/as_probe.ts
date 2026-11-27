@external("cyberspace", "log")
declare function log(ptr: usize, len: i32): void;

export function step(): void {
  const s = "temperature " + (-0.8).toString();
  const buf = String.UTF8.encode(s);
  log(changetype<usize>(buf), buf.byteLength);
  const a = new Array<f64>(10);
  for (let i = 0; i < 10; i++) a[i] = <f64>i * 1.5;
  if (a[3] > 100) throw new Error("too big");
}
