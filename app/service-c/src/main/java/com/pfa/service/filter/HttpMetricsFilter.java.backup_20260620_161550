package com.pfa.service.filter;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.util.concurrent.TimeUnit;

@Component
public class HttpMetricsFilter implements Filter {

    private final MeterRegistry registry;

    public HttpMetricsFilter(MeterRegistry registry) {
        this.registry = registry;
    }

    @Override
    public void doFilter(ServletRequest request, ServletResponse response,
                         FilterChain chain) throws IOException, ServletException {

        HttpServletRequest  req = (HttpServletRequest)  request;
        HttpServletResponse res = (HttpServletResponse) response;
        long startNanos = System.nanoTime();

        try {
            chain.doFilter(request, response);
        } finally {
            long   elapsed = System.nanoTime() - startNanos;
            String method  = req.getMethod();
            String uri     = normalizeUri(req.getRequestURI());
            String status  = String.valueOf(res.getStatus());

            Counter.builder("http_requests_total")
                    .description("Total number of HTTP requests")
                    .tags("method", method, "uri", uri, "status", status)
                    .register(registry)
                    .increment();

            Timer.builder("http_request_duration_seconds")
                    .description("HTTP request latency in seconds")
                    .tags("method", method, "uri", uri, "status", status)
                    .publishPercentiles(0.5, 0.95, 0.99)
                    .register(registry)
                    .record(elapsed, TimeUnit.NANOSECONDS);
        }
    }

    private String normalizeUri(String uri) {
        return uri.replaceAll("/\\d+", "/{id}");
    }
}
