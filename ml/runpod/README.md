# Running the models on RunPod

The `a100` profile runs Qwen3.8-27B (FP8) for deciding and planning, Holo3.1-4B for pointing at
elements, and the embedder, all on one rented 80 GB card. Only the model service runs there. The
database, the app and the crawler's browsers stay on your machine and reach the models through an
SSH tunnel, so nothing on the pod is exposed to the internet.

## Once

1. Add your SSH public key under **Settings → SSH Public Keys**.
2. Create a **network volume** of 80 GB or more under **Storage**, in a data centre that has the
   GPU you want (A100 SXM 80GB or H100). Pods can only attach volumes in their own data centre.

## Each time

1. **Deploy a pod** on that volume: the A100 SXM 80GB, the official **RunPod PyTorch** template
   (CUDA 12.x), and 40 GB of container disk. Don't add the model ports to the exposed HTTP
   ports; the API has no authentication.
2. **Connect** with the "SSH over exposed TCP" command from the pod's Connect tab, then prepare
   the pod. On a new volume this downloads about 45 GB and takes 10 to 20 minutes; on a volume
   that already has everything it only updates the checkout.
   ```sh
   curl -fsSL https://raw.githubusercontent.com/neoworks-dev/refs/main/ml/runpod/setup.sh | bash
   ```
3. **Start the models.** Loading takes a few minutes; the log says "Embedder is ready" at the end.
   ```sh
   bash /workspace/refs/ml/runpod/start.sh
   tail -f /workspace/serve.log
   ```
4. **Open the tunnel** from your machine, with the IP and port from the Connect tab. Stop the
   local model service first, because the tunnel takes over its port 8022.
   ```sh
   go-task ml:tunnel -- root@<ip> -p <port>
   ```
   The crawler and the app now use the rented models as if they ran locally. Check with
   `curl http://127.0.0.1:8022/name-flow/categories`.
5. **Terminate the pod** when you are done, from the RunPod console. A stopped pod still costs
   money for its disk, and the network volume keeps the weights for next time.

To stop the models without ending the pod, run `pkill -TERM -f "serve --profile a100"` there.
