import { it, expect } from "vitest";
import { parseSample } from "../src/protocol";
const valid = "S t=10 n=1 a=0,0,8192 g=0,0,0 m=1,2,3 mn=1 temp=0 ie=0 me=0";
it("rejects malformed samples instead of exposing NaN", () => {
  expect(parseSample(valid)).not.toBeNull();
  for (const line of [
    valid.replace("10", "NaN"),
    valid.replace("0,0,8192", "0,1"),
    valid.replace("mn=1", "mn="),
    valid + " q=1,2,3,4",
  ])
    expect(parseSample(line)).toBeNull();
});
