using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using WealthWatcher.Api.Data;

#nullable disable

namespace WealthWatcher.Api.Migrations
{
    /// <inheritdoc />
    [DbContext(typeof(WealthDbContext))]
    [Migration("20260911120000_AddIntegrationPollingSchedules")]
    public partial class AddIntegrationPollingSchedules : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "PollingScheduleType",
                table: "IntegrationConnections",
                type: "integer",
                nullable: false,
                defaultValue: 1);

            migrationBuilder.AddColumn<string>(
                name: "PollingScheduleValue",
                table: "IntegrationConnections",
                type: "text",
                nullable: false,
                defaultValue: "");

            migrationBuilder.AddColumn<int>(
                name: "PollingScheduleDay",
                table: "IntegrationConnections",
                type: "integer",
                nullable: true);

            migrationBuilder.Sql("""
                UPDATE "IntegrationConnections"
                SET "PollingScheduleValue" = "PollingIntervalMinutes"::text
                WHERE "PollingScheduleValue" = '';
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "PollingScheduleType",
                table: "IntegrationConnections");

            migrationBuilder.DropColumn(
                name: "PollingScheduleValue",
                table: "IntegrationConnections");

            migrationBuilder.DropColumn(
                name: "PollingScheduleDay",
                table: "IntegrationConnections");
        }
    }
}
