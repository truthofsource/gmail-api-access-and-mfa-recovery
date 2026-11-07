mock_provider "azapi" {}
variables {
  name              = "gmail-example-provider-mfa-demo"
  resource_group_id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-example"
  location          = "eastus2"
}
run "historical_connector_stays_off" {
  command = plan
  assert {
    condition     = length(azapi_resource.gmail_readonly_connector) == 0 && length(azapi_resource.gmail_readonly_connection) == 0
    error_message = "The failed historical connector must default Off."
  }
}
run "reject_shared_connector_name" {
  command = plan
  variables { name = "shared-documents-connector" }
  expect_failures = [var.name]
}
