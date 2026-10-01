FROM mcr.microsoft.com/dotnet/sdk:10.0@sha256:35d40304542c8689331f8cab17c65926cdf48fe711e289321d71924b230a7d29 AS build
WORKDIR /src
COPY ["WealthWatcher.WebhookRelay.csproj", "./"]
RUN dotnet restore "./WealthWatcher.WebhookRelay.csproj"
COPY . .
RUN dotnet publish "WealthWatcher.WebhookRelay.csproj" -c Release -o /app/publish /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:10.0@sha256:2d584d8147faddb0d678c5748d47953e5b8e18621ed4fb7049a91381d9d7746f AS final
WORKDIR /app
RUN mkdir -p /data && chown $APP_UID /data
EXPOSE 8080
COPY --from=build /app/publish .
USER $APP_UID
ENTRYPOINT ["dotnet", "WealthWatcher.WebhookRelay.dll"]
