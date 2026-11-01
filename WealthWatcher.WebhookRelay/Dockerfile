FROM mcr.microsoft.com/dotnet/sdk:10.0@sha256:de4fe90a98845d75910b9769662465c84de1a934665c431279d1382b2bddc02b AS build
WORKDIR /src
COPY ["WealthWatcher.WebhookRelay.csproj", "./"]
RUN dotnet restore "./WealthWatcher.WebhookRelay.csproj"
COPY . .
RUN dotnet publish "WealthWatcher.WebhookRelay.csproj" -c Release -o /app/publish /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:10.0@sha256:de0ee358cdd672f7017a003bed21e9ac9ed48a27c922a59b18175b6e82fa7fee AS final
WORKDIR /app
RUN mkdir -p /data && chown $APP_UID /data
EXPOSE 8080
COPY --from=build /app/publish .
USER $APP_UID
ENTRYPOINT ["dotnet", "WealthWatcher.WebhookRelay.dll"]
