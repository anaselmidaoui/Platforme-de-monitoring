package com.pfa.service.controller;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.*;
import java.util.concurrent.*;

@RestController
@RequestMapping("/api")
public class StressController {

    private static final Logger logger = LoggerFactory.getLogger(StressController.class);
    private static final Random random = new Random();

    @Value("${spring.application.name:unknown-service}")
    private String serviceName;

    private volatile boolean cpuStressActive = false;
    private volatile boolean memoryLeakActive = false;
    private volatile boolean errorModeActive = false;
    private volatile long latencyDelay = 0;

    private final List<byte[]> memoryLeakStore = new ArrayList<>();
    private final ExecutorService executor = Executors.newCachedThreadPool();

    @GetMapping("/status")
    public ResponseEntity<?> getStatus() throws InterruptedException {
        if (latencyDelay > 0) {
            Thread.sleep(latencyDelay);
        }
        if (errorModeActive && random.nextBoolean()) {
            logger.error("[{}] Simulated 500 error triggered", serviceName);
            return ResponseEntity.internalServerError()
                    .body(Map.of("error", "Simulated error", "service", serviceName));
        }
        return ResponseEntity.ok(Map.of(
                "service", serviceName,
                "status", "UP",
                "cpuStress", cpuStressActive,
                "memoryLeak", memoryLeakActive,
                "errorMode", errorModeActive,
                "latencyDelay", latencyDelay
        ));
    }

    @PostMapping("/stress/cpu")
    public ResponseEntity<?> stressCpu(@RequestParam boolean active) {
        cpuStressActive = active;
        if (active) {
            executor.submit(() -> {
                logger.warn("[{}] CPU stress loop STARTED", serviceName);
                while (cpuStressActive) {
                    // busy-wait — intentionally saturates one CPU core
                }
                logger.info("[{}] CPU stress loop STOPPED", serviceName);
            });
        }
        return ResponseEntity.ok(Map.of("service", serviceName, "cpuStress", cpuStressActive));
    }

    @PostMapping("/stress/memory")
    public ResponseEntity<?> stressMemory(@RequestParam boolean active) {
        memoryLeakActive = active;
        if (active) {
            executor.submit(() -> {
                logger.warn("[{}] Memory leak simulation STARTED", serviceName);
                while (memoryLeakActive) {
                    try {
                        synchronized (memoryLeakStore) {
                            memoryLeakStore.add(new byte[1024 * 1024]); // allocate 1 MB
                        }
                        Thread.sleep(100);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
                logger.info("[{}] Memory leak simulation STOPPED", serviceName);
            });
        } else {
            synchronized (memoryLeakStore) {
                memoryLeakStore.clear();
            }
            System.gc();
            logger.info("[{}] Memory released and GC requested", serviceName);
        }
        return ResponseEntity.ok(Map.of("service", serviceName, "memoryLeak", memoryLeakActive));
    }

    @PostMapping("/stress/latency")
    public ResponseEntity<?> stressLatency(@RequestParam long delay) {
        this.latencyDelay = delay;
        logger.info("[{}] Artificial latency set to {} ms", serviceName, delay);
        return ResponseEntity.ok(Map.of("service", serviceName, "latencyDelay", latencyDelay));
    }

    @PostMapping("/stress/error")
    public ResponseEntity<?> stressError(@RequestParam boolean active) {
        errorModeActive = active;
        logger.info("[{}] Error mode (50% rate) {}", serviceName, active ? "ACTIVATED" : "DEACTIVATED");
        return ResponseEntity.ok(Map.of("service", serviceName, "errorMode", errorModeActive));
    }
}
