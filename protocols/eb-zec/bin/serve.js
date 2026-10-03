const { loadFixture } = require("../lib/fixture");
const { createApi } = require("../lib/api");

try {
  const file=process.argv[2] || "output/fixture.json";
  const rawPort=process.env.PORT || "8787";
  if(!/^\d{1,5}$/.test(rawPort) || Number(rawPort)<1024 || Number(rawPort)>65535)throw new Error("PORT must be 1024-65535");
  const {indexer}=loadFixture(file),server=createApi(indexer);
  server.requestTimeout=10000;server.headersTimeout=5000;
  server.on("error",error=>{console.error(error.code || error.message);process.exitCode=1;});
  server.listen(Number(rawPort),"127.0.0.1",()=>console.log(`EB-ZEC LOCAL fixture API: http://127.0.0.1:${rawPort}/v1/network`));
  for(const signal of ["SIGINT","SIGTERM"])process.once(signal,()=>server.close(()=>process.exit(0)));
}catch(error){console.error(error.code || error.message);process.exitCode=1;}
