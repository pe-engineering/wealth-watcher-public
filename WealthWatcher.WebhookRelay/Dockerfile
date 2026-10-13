FROM mcr.microsoft.com/dotnet/sdk:10.0@sha256:e70cdb7f80b0348f5cb85f19a8f670fca061f033d57eed12fa003d58b0e06317 AS build
WORKDIR /src
COPY ["WealthWatcher.WebhookRelay.csproj", "./"]
RUN dotnet restore "./WealthWatcher.WebhookRelay.csproj"
COPY . .
RUN dotnet publish "WealthWatcher.WebhookRelay.csproj" -c Release -o /app/publish /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:10.0@sha256:222759b391a1aaf241166672c8f99b2d4ada452e7b5319f3c6e8f265a37b5ad4 AS final
WORKDIR /app
RUN mkdir -p /data && chown $APP_UID /data
EXPOSE 8080
COPY --from=build /app/publish .
USER $APP_UID
ENTRYPOINT ["dotnet", "WealthWatcher.WebhookRelay.dll"]
