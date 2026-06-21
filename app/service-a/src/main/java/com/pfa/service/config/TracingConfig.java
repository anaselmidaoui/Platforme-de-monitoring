package com.pfa.service.config;

import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.exporter.otlp.trace.OtlpGrpcSpanExporter;
import io.opentelemetry.sdk.OpenTelemetrySdk;
import io.opentelemetry.sdk.resources.Resource;
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import io.opentelemetry.sdk.trace.export.BatchSpanProcessor;
import io.opentelemetry.semconv.ResourceAttributes;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class TracingConfig {

    @Value("${otel.exporter.otlp.endpoint:http://jaeger:4317}")
    private String otlpEndpoint;

    @Value("${spring.application.name:unknown-service}")
    private String serviceName;

    @Bean
    @ConditionalOnMissingBean
    public OtlpGrpcSpanExporter otlpGrpcSpanExporter() {
        return OtlpGrpcSpanExporter.builder()
                .setEndpoint(otlpEndpoint)
                .build();
    }

    @Bean
    @ConditionalOnMissingBean
    public OpenTelemetry openTelemetry(OtlpGrpcSpanExporter exporter) {
        Resource resource = Resource.getDefault()
                .merge(Resource.create(Attributes.of(
                        ResourceAttributes.SERVICE_NAME, serviceName
                )));

        SdkTracerProvider tracerProvider = SdkTracerProvider.builder()
                .setResource(resource)
                .addSpanProcessor(BatchSpanProcessor.builder(exporter).build())
                .build();

        return OpenTelemetrySdk.builder()
                .setTracerProvider(tracerProvider)
                .buildAndRegisterGlobal();
    }
}
