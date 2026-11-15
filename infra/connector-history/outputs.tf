output "connector_id" {
  value = try(azapi_resource.gmail_readonly_connector[0].id, null)
}

output "connection_id" {
  value = try(azapi_resource.gmail_readonly_connection[0].id, null)
}

output "callback_url" {
  description = "Service-issued callback to register on the existing Google client; creation is not OAuth consent."
  value       = try(azapi_resource.gmail_readonly_connector[0].output.properties.connectionParameters.token.oAuthSettings.redirectUrl, null)
}
