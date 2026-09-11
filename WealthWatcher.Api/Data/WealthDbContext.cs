using Microsoft.EntityFrameworkCore;
using WealthWatcher.Api.Models;

namespace WealthWatcher.Api.Data;

public class WealthDbContext : DbContext
{
    public WealthDbContext(DbContextOptions<WealthDbContext> options) : base(options)
    {
    }

    public DbSet<Asset> Assets { get; set; } = null!;
    public DbSet<AssetKind> AssetKinds { get; set; } = null!;
    public DbSet<AssetGroup> AssetGroups { get; set; } = null!;
    public DbSet<AssetKindGroup> AssetKindGroups { get; set; } = null!;
    public DbSet<AssetKindAssignment> AssetKindAssignments { get; set; } = null!;

    public DbSet<AssetValueEntry> AssetValueEntries { get; set; } = null!;
    public DbSet<CashAssetValueEntry> CashAssetValueEntries { get; set; } = null!;
    public DbSet<InvestmentAssetValueEntry> InvestmentAssetValueEntries { get; set; } = null!;
    public DbSet<PropertyAssetValueEntry> PropertyAssetValueEntries { get; set; } = null!;
    public DbSet<AssetValueEntrySource> AssetValueEntrySources { get; set; } = null!;
    public DbSet<PropertyDetail> PropertyDetails { get; set; } = null!;

    public DbSet<IntegrationProvider> IntegrationProviders { get; set; } = null!;
    public DbSet<IntegrationConnection> IntegrationConnections { get; set; } = null!;
    public DbSet<IntegrationAccount> IntegrationAccounts { get; set; } = null!;
    public DbSet<IntegrationAccountAssetMapping> IntegrationAccountAssetMappings { get; set; } = null!;
    public DbSet<ExternalValue> ExternalValues { get; set; } = null!;
    public DbSet<ExternalValueAssetMapping> ExternalValueAssetMappings { get; set; } = null!;
    public DbSet<SyncRun> SyncRuns { get; set; } = null!;

    public DbSet<AppPreference> AppPreferences { get; set; } = null!;
    public DbSet<BudgetLine> BudgetLines { get; set; } = null!;
    public DbSet<BudgetLineAssetMapping> BudgetLineAssetMappings { get; set; } = null!;

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);

        modelBuilder.Entity<Asset>(entity =>
        {
            entity.ToTable("Assets");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.DisplayName).IsRequired();
            entity.Property(e => e.AssetGroupAssignmentSet).IsRequired();
            entity.Property(e => e.CreatedAt).IsRequired();
            entity.HasIndex(e => e.DisplayName);
            entity.HasOne(e => e.AssetGroup)
                .WithMany()
                .HasForeignKey(e => e.AssetGroupId)
                .OnDelete(DeleteBehavior.Restrict);
            entity.HasIndex(e => e.AssetGroupId);
        });

        modelBuilder.Entity<AssetKind>(entity =>
        {
            entity.ToTable("AssetKinds");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Code).IsRequired();
            entity.Property(e => e.DisplayName).IsRequired();
            entity.Property(e => e.Color).IsRequired();
            entity.Property(e => e.ValueShape).IsRequired();
            entity.HasIndex(e => e.Code).IsUnique();
        });

        modelBuilder.Entity<AssetGroup>(entity =>
        {
            entity.ToTable("AssetGroups");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Code).IsRequired();
            entity.Property(e => e.DisplayName).IsRequired();
            entity.Property(e => e.Color).IsRequired();
            entity.HasIndex(e => e.Code).IsUnique();
        });

        modelBuilder.Entity<AssetKindGroup>(entity =>
        {
            entity.ToTable("AssetKindGroups");
            entity.HasKey(e => new { e.AssetKindId, e.AssetGroupId });
            entity.HasOne(e => e.AssetKind)
                .WithMany(e => e.GroupMappings)
                .HasForeignKey(e => e.AssetKindId)
                .OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(e => e.AssetGroup)
                .WithMany(e => e.KindMappings)
                .HasForeignKey(e => e.AssetGroupId)
                .OnDelete(DeleteBehavior.Restrict);
            entity.HasIndex(e => e.AssetKindId).IsUnique();
        });

        modelBuilder.Entity<AssetKindAssignment>(entity =>
        {
            entity.ToTable("AssetKindAssignments");
            entity.HasKey(e => new { e.AssetId, e.AssetKindId });
            entity.HasOne(e => e.Asset)
                .WithMany(e => e.AssetKindAssignments)
                .HasForeignKey(e => e.AssetId)
                .OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(e => e.AssetKind)
                .WithMany(e => e.AssetAssignments)
                .HasForeignKey(e => e.AssetKindId)
                .OnDelete(DeleteBehavior.Restrict);
            entity.HasIndex(e => e.AssetId).IsUnique();
        });

        modelBuilder.Entity<AssetValueEntry>(entity =>
        {
            entity.ToTable("AssetValueEntries");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Name).IsRequired();
            entity.Property(e => e.Value).HasColumnType("decimal(18,2)");
            entity.HasOne(e => e.Asset)
                .WithMany(e => e.ValueEntries)
                .HasForeignKey(e => e.AssetId)
                .OnDelete(DeleteBehavior.Restrict);
            entity.HasIndex(e => new { e.AssetId, e.Date, e.Time });
            entity.HasDiscriminator<string>("Discriminator")
                .HasValue<CashAssetValueEntry>("CashAssetValueEntry")
                .HasValue<CashEntry>("CashEntry")
                .HasValue<InvestmentAssetValueEntry>("InvestmentAssetValueEntry")
                .HasValue<InvestmentEntry>("InvestmentEntry")
                .HasValue<PropertyAssetValueEntry>("PropertyAssetValueEntry")
                .HasValue<PropertyEntry>("PropertyEntry");
        });

        modelBuilder.Entity<PropertyAssetValueEntry>()
            .Property(e => e.Mortgage)
            .HasColumnType("decimal(18,2)");
        modelBuilder.Entity<InvestmentAssetValueEntry>()
            .Property(e => e.InvestedCapital)
            .HasColumnType("decimal(18,2)");
        modelBuilder.Entity<InvestmentAssetValueEntry>()
            .OwnsMany(e => e.Positions, builder => builder.ToJson());

        modelBuilder.Entity<PropertyDetail>(entity =>
        {
            entity.ToTable("PropertyDetails");
            entity.HasKey(e => e.AssetId);
            entity.HasOne(e => e.Asset)
                .WithOne(e => e.PropertyDetail)
                .HasForeignKey<PropertyDetail>(e => e.AssetId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<AssetValueEntrySource>(entity =>
        {
            entity.ToTable("AssetValueEntrySources");
            entity.HasKey(e => e.AssetValueEntryId);
            entity.HasOne(e => e.AssetValueEntry)
                .WithOne(e => e.SourceLink)
                .HasForeignKey<AssetValueEntrySource>(e => e.AssetValueEntryId)
                .OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(e => e.ExternalValue)
                .WithMany(e => e.EntrySources)
                .HasForeignKey(e => e.ExternalValueId)
                .OnDelete(DeleteBehavior.SetNull);
            entity.HasOne(e => e.SyncRun)
                .WithMany()
                .HasForeignKey(e => e.SyncRunId)
                .OnDelete(DeleteBehavior.SetNull);
            entity.HasIndex(e => e.ExternalValueId);
        });

        modelBuilder.Entity<IntegrationProvider>(entity =>
        {
            entity.ToTable("IntegrationProviders");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Code).IsRequired();
            entity.Property(e => e.DisplayName).IsRequired();
            entity.HasIndex(e => e.Code).IsUnique();
        });

        modelBuilder.Entity<IntegrationConnection>(entity =>
        {
            entity.ToTable("IntegrationConnections");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Kind).HasConversion<int>().IsRequired();
            entity.Property(e => e.Status).HasConversion<int>().IsRequired();
            entity.Property(e => e.SyncMode).HasConversion<int>().IsRequired();
            entity.Property(e => e.PollingScheduleType).HasConversion<int>().IsRequired();
            entity.Property(e => e.DisplayName).IsRequired();
            entity.Property(e => e.OptionsJson).IsRequired();
            entity.Property(e => e.CredentialsCiphertext).IsRequired();
            entity.Property(e => e.PollingIntervalMinutes).IsRequired();
            entity.Property(e => e.PollingScheduleValue).IsRequired();
            entity.Property(e => e.PollingScheduleDay).HasConversion<int?>();
            entity.Property(e => e.OnlyPollDuringMarketTimes).IsRequired();
            entity.HasOne(e => e.IntegrationProvider)
                .WithMany(e => e.Connections)
                .HasForeignKey(e => e.IntegrationProviderId)
                .OnDelete(DeleteBehavior.Restrict);
            entity.HasIndex(e => new { e.IntegrationProviderId, e.DisplayName }).IsUnique();
        });

        modelBuilder.Entity<IntegrationAccount>(entity =>
        {
            entity.ToTable("IntegrationAccounts");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.ExternalId).IsRequired();
            entity.Property(e => e.DisplayName).IsRequired();
            entity.Property(e => e.AccountType).IsRequired();
            entity.Property(e => e.Currency).IsRequired();
            entity.Property(e => e.Status).HasConversion<int>().IsRequired();
            entity.HasOne(e => e.IntegrationConnection)
                .WithMany(e => e.Accounts)
                .HasForeignKey(e => e.IntegrationConnectionId)
                .OnDelete(DeleteBehavior.Cascade);
            entity.HasIndex(e => new { e.IntegrationConnectionId, e.ExternalId }).IsUnique();
        });

        modelBuilder.Entity<IntegrationAccountAssetMapping>(entity =>
        {
            entity.ToTable("IntegrationAccountAssetMappings");
            entity.HasKey(e => new { e.IntegrationAccountId, e.Role });
            entity.Property(e => e.Role).HasConversion<int>().IsRequired();
            entity.HasOne(e => e.IntegrationAccount)
                .WithMany(e => e.AssetMappings)
                .HasForeignKey(e => e.IntegrationAccountId)
                .OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(e => e.Asset)
                .WithMany(e => e.IntegrationAccountMappings)
                .HasForeignKey(e => e.AssetId)
                .OnDelete(DeleteBehavior.Restrict);
        });

        modelBuilder.Entity<ExternalValue>(entity =>
        {
            entity.ToTable("ExternalValues");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.ExternalId).IsRequired();
            entity.Property(e => e.DisplayName).IsRequired();
            entity.Property(e => e.Role).HasConversion<int>().IsRequired();
            entity.HasOne(e => e.IntegrationAccount)
                .WithMany(e => e.ExternalValues)
                .HasForeignKey(e => e.IntegrationAccountId)
                .OnDelete(DeleteBehavior.Cascade);
            entity.HasIndex(e => new { e.IntegrationAccountId, e.ExternalId }).IsUnique();
        });

        modelBuilder.Entity<ExternalValueAssetMapping>(entity =>
        {
            entity.ToTable("ExternalValueAssetMappings");
            entity.HasKey(e => e.ExternalValueId);
            entity.HasOne(e => e.ExternalValue)
                .WithMany(e => e.AssetMappings)
                .HasForeignKey(e => e.ExternalValueId)
                .OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(e => e.Asset)
                .WithMany(e => e.ExternalValueMappings)
                .HasForeignKey(e => e.AssetId)
                .OnDelete(DeleteBehavior.Restrict);
        });

        modelBuilder.Entity<SyncRun>(entity =>
        {
            entity.ToTable("SyncRuns");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Status).HasConversion<int>().IsRequired();
            entity.Property(e => e.ConnectionDisplayNameSnapshot).IsRequired();
            entity.HasOne(e => e.IntegrationConnection)
                .WithMany(e => e.SyncRuns)
                .HasForeignKey(e => e.IntegrationConnectionId)
                .OnDelete(DeleteBehavior.SetNull);
            entity.HasIndex(e => e.IntegrationConnectionId);
        });

        modelBuilder.Entity<AppPreference>(entity =>
        {
            entity.ToTable("AppPreferences");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.GeneralJson).IsRequired();
            entity.Property(e => e.FeatureJson).IsRequired();
            entity.Property(e => e.ForecastJson).IsRequired();
            entity.Property(e => e.FireJson).IsRequired();
            entity.Property(e => e.IntegrationJson).IsRequired();
            entity.Property(e => e.MilestoneJson)
                .IsRequired()
                .HasDefaultValue(MilestoneSettingsPolicy.DefaultJson);
            entity.Property(e => e.BudgetJson)
                .IsRequired(false);
        });

        modelBuilder.Entity<BudgetLine>(entity =>
        {
            entity.ToTable("BudgetLines");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Category).HasConversion<int>().IsRequired();
            entity.Property(e => e.Cadence).HasConversion<int>().IsRequired();
            entity.Property(e => e.Name).IsRequired();
            entity.Property(e => e.Amount).HasColumnType("decimal(18,2)");
        });

        modelBuilder.Entity<BudgetLineAssetMapping>(entity =>
        {
            entity.ToTable("BudgetLineAssetMappings");
            entity.HasKey(e => new { e.BudgetLineId, e.AssetId });
            entity.HasOne(e => e.BudgetLine)
                .WithMany(e => e.AssetMappings)
                .HasForeignKey(e => e.BudgetLineId)
                .OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(e => e.Asset)
                .WithMany()
                .HasForeignKey(e => e.AssetId)
                .OnDelete(DeleteBehavior.Restrict);
            entity.HasIndex(e => e.BudgetLineId).IsUnique();
        });
    }
}
