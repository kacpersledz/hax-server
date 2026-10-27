# Built-in stadium sources

These ten `.hbs` files are bundled verbatim from the stadium archive in
[HaxBall's maintained `haxball-issues` repository](https://github.com/haxball/haxball-issues/tree/master/stadiums).
The original [HaxBall announcement](https://blog.haxball.com/2011/12/08/default-stadiums-in-hbs-format.html)
lists the same ten built-in stadiums and originally linked the `.hbs` downloads.

The SHA values below are Git blob IDs for the upstream files. Startup verifies
each local file against its ID and checks that its JSON `name` matches the
expected stadium. Keep these files unchanged; randomized stadiums are generated
from them in memory.

| Stadium | File | Upstream blob SHA |
| --- | --- | --- |
| Classic | `classic.hbs` | `9e0aa039fc395fb02c4669f9aa00feaacef2e350` |
| Rounded | `rounded.hbs` | `938e8796ffbd72e39d5271d03113ef785095baf7` |
| Easy | `easy.hbs` | `39726b460f5e396886b47e3bbc7091a25c536421` |
| Small | `small.hbs` | `94d51dac3c011a72bb2f48d85d72159fecfb260c` |
| Hockey | `hockey.hbs` | `9c82f471f1f6cc551a2ef118c822652fd1cd9df4` |
| Big | `big.hbs` | `89861213f2de3888d13c138587eb0aff178b4025` |
| Big Rounded | `big_rounded.hbs` | `7f1e73a245f31e9200dbd5bc1ae27f3387ab4ce9` |
| Big Easy | `big_easy.hbs` | `e53c389576c844456a0027a8487c9b98790c4ec0` |
| Big Hockey | `big_hockey.hbs` | `a9b07188a1607cbff7f38d6adf5f0bb8d57aec3b` |
| Huge | `huge.hbs` | `fb73cfe906faeb5327330c28b8559bf77d456f7d` |
